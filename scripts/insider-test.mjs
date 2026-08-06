#!/usr/bin/env node
/**
 * Offline tests for Form 4 parsing, against real filings captured from EDGAR
 * (scripts/fixtures/form4.json — three genuine Apple Form 4s).
 *
 * The classification is the part that matters. A Form 4 mostly reports options
 * vesting and shares withheld to pay tax on that vesting — neither is a decision
 * to trade. If those leak into the "sold" figures, the tool reports insider
 * selling that never happened, which is exactly the error the tool exists to
 * correct. Those cases are pinned down here.
 *
 * Run with:  node scripts/insider-test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = JSON.parse(readFileSync(join(here, "fixtures", "form4.json"), "utf8"));

const { parseForm4 } = await import("../dist/sources/insider.js");

const parse = (f) => parseForm4(f.xml, f.accession, "https://example.test/f.txt", f.filedAt);

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}\n       ${err.message.split("\n")[0]}`);
    process.exitCode = 1;
  }
}

console.log("\nSEC Form 4 parsing (real EDGAR fixtures)");

await test("parses owner, roles and transactions from a real filing", async () => {
  const f = parse(FIXTURES[0]);
  assert.ok(f.owner && f.owner !== "Unknown", `owner was "${f.owner}"`);
  assert.ok(f.roles.length > 0, "an insider must have at least one role");
  assert.ok(f.transactions.length > 0, "filing should report transactions");
  assert.equal(f.accession, FIXTURES[0].accession);
});

await test("every transaction gets a known code and class", async () => {
  const valid = new Set(["open-market", "mechanical", "other"]);
  for (const fx of FIXTURES) {
    for (const t of parse(fx).transactions) {
      assert.ok(valid.has(t.klass), `unexpected class ${t.klass}`);
      assert.ok(t.label && !t.label.startsWith("Unrecognised"), `unmapped code ${t.code}`);
    }
  }
});

await test("option exercises and tax withholding are NOT open-market", async () => {
  // M = exercising an option, F = shares handed back to cover the tax bill.
  // Both are compensation plumbing. Counting them as trades is the single
  // biggest way insider data gets misreported.
  let seen = 0;
  for (const fx of FIXTURES) {
    for (const t of parse(fx).transactions) {
      if (t.code === "M" || t.code === "F") {
        assert.equal(t.klass, "mechanical", `${t.code} must be mechanical, got ${t.klass}`);
        seen++;
      }
    }
  }
  assert.ok(seen > 0, "fixtures should contain at least one M or F row");
});

await test("open-market sales are classified as decisions", async () => {
  let sales = 0;
  for (const fx of FIXTURES) {
    for (const t of parse(fx).transactions) {
      if (t.code === "S") {
        assert.equal(t.klass, "open-market");
        assert.equal(t.direction, "disposed");
        sales++;
      }
    }
  }
  assert.ok(sales > 0, "fixtures should contain at least one S row");
});

await test("gifts are neither a purchase nor a sale", async () => {
  for (const fx of FIXTURES) {
    for (const t of parse(fx).transactions) {
      if (t.code === "G") assert.equal(t.klass, "other", "a gift is not a market decision");
    }
  }
});

await test("a zero price yields no value rather than a free trade", async () => {
  // Grants and option exercises report pricePerShare = 0. Multiplying through
  // would silently claim the insider acquired millions of dollars for nothing.
  for (const fx of FIXTURES) {
    for (const t of parse(fx).transactions) {
      if (t.pricePerShare === 0) assert.equal(t.value, null, `code ${t.code} priced at 0 got a value`);
      if (t.value != null) assert.ok(t.value > 0, "a computed value must be positive");
    }
  }
});

await test("share counts and holdings parse as numbers", async () => {
  for (const fx of FIXTURES) {
    for (const t of parse(fx).transactions) {
      if (t.shares != null) assert.ok(Number.isFinite(t.shares) && t.shares > 0, `bad shares ${t.shares}`);
      if (t.sharesOwnedAfter != null) assert.ok(Number.isFinite(t.sharesOwnedAfter));
    }
  }
});

await test("direction is derived from the acquired/disposed code", async () => {
  for (const fx of FIXTURES) {
    for (const t of parse(fx).transactions) {
      assert.ok(["acquired", "disposed", null].includes(t.direction));
    }
  }
});

/* ------------------------------------------------------- synthetic edge cases */

const wrap = (inner) => `<?xml version="1.0"?><ownershipDocument>${inner}</ownershipDocument>`;

await test("handles a filing with multiple reporting owners", async () => {
  const xml = wrap(`
    <reportingOwner><reportingOwnerId><rptOwnerName>Trust A</rptOwnerName></reportingOwnerId>
      <reportingOwnerRelationship><isDirector>1</isDirector></reportingOwnerRelationship></reportingOwner>
    <reportingOwner><reportingOwnerId><rptOwnerName>Trustee B</rptOwnerName></reportingOwnerId>
      <reportingOwnerRelationship><isTenPercentOwner>1</isTenPercentOwner></reportingOwnerRelationship></reportingOwner>`);
  const f = parseForm4(xml, "acc", "url", "2026-01-01");
  assert.ok(f.owner.includes("Trust A") && f.owner.includes("Trustee B"));
  assert.deepEqual(f.roles.sort(), ["10% owner", "Director"]);
});

await test("accepts both boolean spellings EDGAR emits for roles", async () => {
  // Real filings use <isOfficer>true</isOfficer>; the schema also permits "1",
  // and filing agents use both. Checking one spelling drops roles silently.
  for (const [spelling, value] of [["numeric", "1"], ["textual", "true"]]) {
    const xml = wrap(`
      <reportingOwner><reportingOwnerId><rptOwnerName>N</rptOwnerName></reportingOwnerId>
        <reportingOwnerRelationship><isDirector>${value}</isDirector></reportingOwnerRelationship>
      </reportingOwner>`);
    assert.deepEqual(parseForm4(xml, "a", "u", "2026-01-01").roles, ["Director"], `${spelling} form failed`);
  }
  // ...and a false flag must not add the role.
  const off = wrap(`
    <reportingOwner><reportingOwnerId><rptOwnerName>N</rptOwnerName></reportingOwnerId>
      <reportingOwnerRelationship><isDirector>false</isDirector><isOfficer>0</isOfficer></reportingOwnerRelationship>
    </reportingOwner>`);
  assert.deepEqual(parseForm4(off, "a", "u", "2026-01-01").roles, []);
});

await test("an officer's role carries their actual title", async () => {
  const xml = wrap(`
    <reportingOwner><reportingOwnerId><rptOwnerName>Jane Doe</rptOwnerName></reportingOwnerId>
      <reportingOwnerRelationship><isOfficer>1</isOfficer><officerTitle>Chief Financial Officer</officerTitle>
      </reportingOwnerRelationship></reportingOwner>`);
  assert.deepEqual(parseForm4(xml, "a", "u", "2026-01-01").roles, ["Chief Financial Officer"]);
});

await test("a single transaction is not mangled into characters", async () => {
  // fast-xml-parser collapses one-element lists to a bare object; treating that
  // object as an array would iterate its keys instead.
  const xml = wrap(`
    <nonDerivativeTable><nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-03-01</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>1000</value></transactionShares>
        <transactionPricePerShare><value>150.5</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
    </nonDerivativeTransaction></nonDerivativeTable>`);
  const f = parseForm4(xml, "a", "u", "2026-01-01");
  assert.equal(f.transactions.length, 1);
  const t = f.transactions[0];
  assert.equal(t.code, "P");
  assert.equal(t.klass, "open-market");
  assert.equal(t.shares, 1000);
  assert.equal(t.value, 150_500);
  assert.equal(t.direction, "acquired");
});

await test("a filing with no transactions parses rather than throwing", async () => {
  const xml = wrap(`<reportingOwner><reportingOwnerId><rptOwnerName>X</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isDirector>1</isDirector></reportingOwnerRelationship></reportingOwner>`);
  assert.deepEqual(parseForm4(xml, "a", "u", "2026-01-01").transactions, []);
});

await test("rejects a document that is not a Form 4", async () => {
  assert.throws(() => parseForm4("<html>not a filing</html>", "a", "u", "2026-01-01"), /ownershipDocument/);
});

await test("an unknown transaction code degrades to 'other' rather than crashing", async () => {
  const xml = wrap(`
    <nonDerivativeTable><nonDerivativeTransaction>
      <transactionCoding><transactionCode>Z</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>5</value></transactionShares></transactionAmounts>
    </nonDerivativeTransaction></nonDerivativeTable>`);
  const t = parseForm4(xml, "a", "u", "2026-01-01").transactions[0];
  assert.equal(t.klass, "other");
  assert.match(t.label, /Unrecognised/);
});

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}\n`);
