import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, stat, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const hash = value => createHash("sha256").update(value).digest("hex")
const root = fileURLToPath(new URL("..", import.meta.url))

// A read-only QA extractor for the reviewed embedded JSON layout. It never
// executes Codex, reads a user Home, generates a Hook command or installs hooks.
export function extractCommandInputSchema(binary, title) {
  const titleAt = binary.indexOf(Buffer.from(`"title": "${title}"`))
  assert(titleAt >= 0, `Missing embedded schema: ${title}`)
  const start = Math.max(...['{\n  "$schema"', '{\r\n  "$schema"'].map(prefix => binary.lastIndexOf(Buffer.from(prefix), titleAt)))
  assert(start >= 0 && titleAt - start < 65536, `Invalid embedded schema boundary: ${title}`)
  let depth = 0, quoted = false, escaped = false
  for (let i = start; i < Math.min(binary.length, start + 65536); i++) {
    const ch = binary[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (ch === 92) escaped = true
      else if (ch === 34) quoted = false
    } else if (ch === 34) quoted = true
    else if (ch === 123) depth++
    else if (ch === 125 && --depth === 0) {
      const schema = JSON.parse(binary.subarray(start, i + 1).toString("utf8"))
      assert.equal(schema.title, title)
      return schema
    }
  }
  throw new Error(`Unterminated embedded schema: ${title}`)
}

// These input schemas use only the following draft-07 subset. Fail on any new
// keyword rather than silently validating a future, unreviewed schema shape.
export function assertWireFixture(schema, input, rootSchema = schema) {
  if (schema === true) return
  assert(schema && typeof schema === "object", "Unsupported schema shape")
  const supported = new Set(["$schema", "title", "description", "definitions", "$ref", "type", "const", "enum", "required", "properties", "additionalProperties"])
  for (const key of Object.keys(schema)) assert(supported.has(key), `Unsupported schema keyword: ${key}`)
  if (schema.$ref) {
    assert(/^#\/definitions\/[A-Za-z0-9_]+$/.test(schema.$ref), "Non-local schema reference")
    return assertWireFixture(rootSchema.definitions[schema.$ref.split("/").at(-1)], input, rootSchema)
  }
  if (schema.type) {
    const actual = input === null ? "null" : Array.isArray(input) ? "array" : typeof input
    assert([schema.type].flat().includes(actual), `Expected ${schema.type}, got ${actual}`)
  }
  if (Object.hasOwn(schema, "const")) assert.deepEqual(input, schema.const)
  if (schema.enum) assert(schema.enum.includes(input), "Value is outside schema enum")
  if (schema.required) for (const key of schema.required) assert(Object.hasOwn(input, key), `Missing required property: ${key}`)
  if (schema.properties) for (const [key, value] of Object.entries(input)) {
    if (Object.hasOwn(schema.properties, key)) assertWireFixture(schema.properties[key], value, rootSchema)
    else assert(schema.additionalProperties !== false, `Unrecognized fixture property: ${key}`)
  }
}

async function main() {
  const [binaryPath, flag, outputPath, ...extra] = process.argv.slice(2)
  assert(binaryPath && flag === "--output" && outputPath && !extra.length, "Usage: node scripts/verify-codex-hook-contract.mjs <native CLI> --output <new evidence.json>")
  const fixturePath = resolve(root, "tests/fixtures/codex-hooks/contract-v0.153.4.json")
  const fixtureBytes = await readFile(fixturePath), fixture = JSON.parse(fixtureBytes.toString("utf8"))
  const size = (await stat(binaryPath)).size
  assert(size > 0 && size <= 350 * 1024 * 1024, "Unexpected CLI artifact size")
  const binary = await readFile(binaryPath), artifactSha256 = hash(binary)
  assert.equal(artifactSha256, fixture.artifactSha256, "CLI artifact is not the reviewed fixture source")
  const events = fixture.events.map(item => {
    const extracted = extractCommandInputSchema(binary, item.schema.title)
    assert.deepEqual(extracted, item.schema, `Embedded schema differs: ${item.event}`)
    assertWireFixture(extracted, item.input)
    // SessionEnd is advisory and has no embedded command-output schema. The
    // official event reference documents that its output cannot steer Codex.
    const output = item.event === "SessionEnd" ? null : extractCommandInputSchema(binary, item.schema.title.replace(/\.input$/, ".output"))
    if (output) assertWireFixture(output, {})
    return { event: item.event, title: extracted.title, embeddedSchemaMatched: true, schemaSha256: hash(JSON.stringify(extracted)), fixtureValidAgainstSchema: true, outputSchemaSha256: output ? hash(JSON.stringify(output)) : null, emptyCommandResponseAccepted: output ? true : null, outputHandling: output ? "schema-checked" : "advisory; no embedded output schema", parserSupport: "supported", actualDelivery: "not-tested" }
  })
  const report = { schemaVersion: 1, recordedAt: new Date().toISOString(), source: "installed-cli-embedded-command-input-schemas-and-synthetic-fixtures", version: fixture.codexVersion, platform: fixture.platform, architecture: fixture.architecture, artifactSha256, fixtureSha256: hash(fixtureBytes), events, sessionEndReference: "https://learn.chatgpt.com/docs/hooks#sessionend", modelRequestsSubmitted: 0, actualCliHook: "not-tested", actualDesktopHook: "not-tested" }
  await writeFile(resolve(outputPath), JSON.stringify(report, null, 2) + "\n", { flag: "wx" })
  console.log(JSON.stringify({ status: "passed", version: report.version, artifactSha256, events: events.length, modelRequestsSubmitted: 0 }))
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main()
