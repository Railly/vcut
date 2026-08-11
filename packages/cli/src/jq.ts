/**
 * `--jq <expr>`, a minimal jq-subset evaluator for JSON already in memory.
 *
 * No dependency ships a jq-subset that fits: node-jq and its siblings shell out to a real jq
 * binary on PATH, which the issue this implements rules out directly. jq-web/jq-wasm embed
 * actual jq compiled to WASM (3-4MB unpacked) — not a shell-out, but not "small" or auditable
 * either, and still real jq rather than a subset this codebase owns. jmespath and jsonata are
 * pure JS and tiny, but a different query language: an agent that already knows jq syntax
 * (select(), sort_by(), field access) would have to learn a second one to use --jq, which
 * defeats the point of the flag being familiar. jq-in-the-browser and jqjs are pure JS and
 * jq-syntax, but both stalled in 2022 with a single maintainer and near-zero adoption
 * (2,161 and 46 monthly downloads respectively) — not something to depend on for a CLI's own
 * flag. So this implements the slice of jq syntax the issue's own motivating cases need:
 * field access, array iteration, select() with comparisons, and sort_by(). Documented in full
 * in JQ_HELP below, which the --help text for every command that accepts --jq quotes verbatim.
 *
 * This is a filter, not a language: no variables, no user functions, no reduce/foreach, no
 * string interpolation. Anything past the documented subset throws a UsageError naming exactly
 * what was not understood, rather than silently returning something close.
 */

import { UsageError } from './output.ts'

export const JQ_HELP = `--jq subset supported:
  .                        identity
  .field, .a.b.c           field access (dot path)
  .[]                      iterate array elements
  .field[]                 field access then iterate
  select(EXPR)             keep elements where EXPR is truthy
  sort_by(.field)          sort an array by a field, ascending (needs an array; run it on
                           . or a field, not after .[] | select(...), see below)
  .a | .b                  pipe: chain steps left to right
  Comparisons inside select(): ==, !=, <, <=, >, >=
    .field == "string" | .field == 42 | .field == true | .field == null
  Boolean combinators inside select(): and, or, not(EXPR)
Not supported: variables, user functions, reduce/foreach, string interpolation,
math operators, regex, object/array construction ({...} or [...]). Without [...] to
re-collect results, select(...) cannot feed directly into sort_by(...) in one pipeline;
filter and sort as two separate calls instead. Errors name what was not understood.`

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

type Token =
  | { kind: 'dot' }
  | { kind: 'ident'; value: string }
  | { kind: 'lbracket' }
  | { kind: 'rbracket' }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'pipe' }
  | { kind: 'op'; value: '==' | '!=' | '<=' | '>=' | '<' | '>' }
  | { kind: 'and' }
  | { kind: 'or' }
  | { kind: 'not' }
  | { kind: 'literal'; value: string | number | boolean | null }

// Tokenizing by hand rather than a regex-split: a quoted string can contain any of the
// characters that would otherwise be delimiters (".", "|", spaces), so the string body has to
// be consumed char-by-char before the rest of the scanner resumes.
const tokenize = (expr: string): Token[] => {
  const tokens: Token[] = []
  let index = 0

  const peekWord = (): string => {
    let end = index
    while (end < expr.length && /[a-zA-Z_]/.test(expr[end])) {
      end += 1
    }
    return expr.slice(index, end)
  }

  while (index < expr.length) {
    const char = expr[index]

    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char === '.') {
      tokens.push({ kind: 'dot' })
      index += 1
      continue
    }
    if (char === '[') {
      tokens.push({ kind: 'lbracket' })
      index += 1
      continue
    }
    if (char === ']') {
      tokens.push({ kind: 'rbracket' })
      index += 1
      continue
    }
    if (char === '(') {
      tokens.push({ kind: 'lparen' })
      index += 1
      continue
    }
    if (char === ')') {
      tokens.push({ kind: 'rparen' })
      index += 1
      continue
    }
    if (char === '|') {
      tokens.push({ kind: 'pipe' })
      index += 1
      continue
    }
    if (char === '=' && expr[index + 1] === '=') {
      tokens.push({ kind: 'op', value: '==' })
      index += 2
      continue
    }
    if (char === '!' && expr[index + 1] === '=') {
      tokens.push({ kind: 'op', value: '!=' })
      index += 2
      continue
    }
    if (char === '<' && expr[index + 1] === '=') {
      tokens.push({ kind: 'op', value: '<=' })
      index += 2
      continue
    }
    if (char === '>' && expr[index + 1] === '=') {
      tokens.push({ kind: 'op', value: '>=' })
      index += 2
      continue
    }
    if (char === '<') {
      tokens.push({ kind: 'op', value: '<' })
      index += 1
      continue
    }
    if (char === '>') {
      tokens.push({ kind: 'op', value: '>' })
      index += 1
      continue
    }
    if (char === '"') {
      let end = index + 1
      let value = ''
      while (end < expr.length && expr[end] !== '"') {
        if (expr[end] === '\\' && end + 1 < expr.length) {
          value += expr[end + 1]
          end += 2
          continue
        }
        value += expr[end]
        end += 1
      }
      if (end >= expr.length) {
        throw new UsageError(`--jq: unterminated string in "${expr}"`)
      }
      tokens.push({ kind: 'literal', value })
      index = end + 1
      continue
    }
    if (/[0-9]/.test(char) || (char === '-' && /[0-9]/.test(expr[index + 1] ?? ''))) {
      let end = index + 1
      while (end < expr.length && /[0-9.]/.test(expr[end])) {
        end += 1
      }
      tokens.push({ kind: 'literal', value: Number(expr.slice(index, end)) })
      index = end
      continue
    }
    if (/[a-zA-Z_]/.test(char)) {
      const word = peekWord()
      index += word.length
      if (word === 'true') {
        tokens.push({ kind: 'literal', value: true })
      } else if (word === 'false') {
        tokens.push({ kind: 'literal', value: false })
      } else if (word === 'null') {
        tokens.push({ kind: 'literal', value: null })
      } else if (word === 'and') {
        tokens.push({ kind: 'and' })
      } else if (word === 'or') {
        tokens.push({ kind: 'or' })
      } else if (word === 'not') {
        tokens.push({ kind: 'not' })
      } else {
        tokens.push({ kind: 'ident', value: word })
      }
      continue
    }
    throw new UsageError(`--jq: unexpected character '${char}' in "${expr}". ${JQ_HELP}`)
  }

  return tokens
}

type Step =
  | { op: 'identity' }
  | { op: 'field'; name: string }
  | { op: 'iterate' }
  | { op: 'select'; test: BoolExpr }
  | { op: 'sortBy'; path: string[] }

type Comparison = {
  path: string[]
  operator: '==' | '!=' | '<' | '<=' | '>' | '>='
  literal: string | number | boolean | null
}

type BoolExpr =
  | { kind: 'compare'; value: Comparison }
  | { kind: 'and'; left: BoolExpr; right: BoolExpr }
  | { kind: 'or'; left: BoolExpr; right: BoolExpr }
  | { kind: 'not'; value: BoolExpr }

// A recursive-descent parser over the token stream, not a general expression grammar: the
// only place an expression nests is inside select(...) and not(...), and both only ever hold
// a chain of comparisons joined by and/or. Anything shaped differently throws by construction
// rather than by an extra check, since there is no production that accepts it.
class Parser {
  private tokens: Token[]
  private pos = 0
  private readonly source: string

  constructor(tokens: Token[], source: string) {
    this.tokens = tokens
    this.source = source
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos]
  }

  private next(): Token {
    const token = this.tokens[this.pos]
    if (token === undefined) {
      throw new UsageError(`--jq: unexpected end of expression in "${this.source}". ${JQ_HELP}`)
    }
    this.pos += 1
    return token
  }

  private expect<T extends Token['kind']>(kind: T): Extract<Token, { kind: T }> {
    const token = this.next()
    if (token.kind !== kind) {
      throw new UsageError(
        `--jq: expected ${kind} but got ${token.kind} in "${this.source}". ${JQ_HELP}`,
      )
    }
    return token as Extract<Token, { kind: T }>
  }

  // A single dot path segment run: `a.b.c` up to (not including) the next `[` or pipe. The
  // leading dot is already consumed by the caller. Stops rather than loops past a `[` so the
  // caller can interleave field steps and iterate steps in source order (`.a.b[].c[]`).
  private parsePath(): string[] {
    const segments: string[] = []
    while (this.peek()?.kind === 'ident') {
      segments.push(this.expect('ident').value)
      if (this.peek()?.kind === 'dot') {
        this.next()
        continue
      }
      break
    }
    return segments
  }

  parseSteps(): Step[] {
    const steps: Step[] = []
    for (;;) {
      steps.push(...this.parseStep())
      if (this.peek()?.kind === 'pipe') {
        this.next()
        continue
      }
      break
    }
    if (this.pos < this.tokens.length) {
      throw new UsageError(
        `--jq: unexpected trailing input in "${this.source}" at token ${this.pos}. ${JQ_HELP}`,
      )
    }
    return steps
  }

  // One pipe segment can itself expand to several steps: `.field[]` is a field step followed
  // by an iterate step, both produced from one segment so the caller's pipe loop stays flat.
  private parseStep(): Step[] {
    const token = this.peek()

    if (token?.kind === 'dot') {
      this.next()
      const steps: Step[] = []
      // `.a.b[].c[].d` alternates path segments and `[]` iterations in source order: each
      // group of path segments becomes one field step per segment, then a `[]` right after
      // becomes an iterate step, and the loop repeats for whatever dot path follows it.
      for (;;) {
        const path = this.parsePath()
        for (const name of path) {
          steps.push({ op: 'field', name })
        }
        let sawBracket = false
        while (this.peek()?.kind === 'lbracket') {
          this.next()
          this.expect('rbracket')
          steps.push({ op: 'iterate' })
          sawBracket = true
        }
        if (sawBracket && this.peek()?.kind === 'dot') {
          this.next()
          continue
        }
        break
      }
      return steps.length === 0 ? [{ op: 'identity' }] : steps
    }

    if (token?.kind === 'ident' && token.value === 'select') {
      this.next()
      this.expect('lparen')
      const test = this.parseBoolExpr()
      this.expect('rparen')
      return [{ op: 'select', test }]
    }

    if (token?.kind === 'ident' && token.value === 'sort_by') {
      this.next()
      this.expect('lparen')
      this.expect('dot')
      const path = this.parsePath()
      this.expect('rparen')
      return [{ op: 'sortBy', path }]
    }

    if (token?.kind === 'ident') {
      throw new UsageError(
        `--jq: unknown function '${token.value}' in "${this.source}". ${JQ_HELP}`,
      )
    }

    throw new UsageError(`--jq: could not parse "${this.source}" at token ${this.pos}. ${JQ_HELP}`)
  }

  // and/or read left to right at one precedence, same as jq's own boolean operators inside a
  // select(): `a == 1 and b == 2 or c == 3` groups as `(a and b) or c`. Parenthesised grouping
  // beyond not(...) is out of scope for this subset.
  private parseBoolExpr(): BoolExpr {
    let left = this.parseBoolUnary()
    for (;;) {
      const token = this.peek()
      if (token?.kind === 'and') {
        this.next()
        left = { kind: 'and', left, right: this.parseBoolUnary() }
        continue
      }
      if (token?.kind === 'or') {
        this.next()
        left = { kind: 'or', left, right: this.parseBoolUnary() }
        continue
      }
      break
    }
    return left
  }

  private parseBoolUnary(): BoolExpr {
    if (this.peek()?.kind === 'not') {
      this.next()
      this.expect('lparen')
      const inner = this.parseBoolExpr()
      this.expect('rparen')
      return { kind: 'not', value: inner }
    }
    return { kind: 'compare', value: this.parseComparison() }
  }

  private parseComparison(): Comparison {
    this.expect('dot')
    const path = this.parsePath()
    if (path.length === 0) {
      throw new UsageError(
        `--jq: select() needs a field to compare, got bare '.' in "${this.source}". ${JQ_HELP}`,
      )
    }
    const opToken = this.next()
    if (opToken.kind !== 'op') {
      throw new UsageError(
        `--jq: expected a comparison operator (==, !=, <, <=, >, >=) after .${path.join('.')} in "${this.source}". ${JQ_HELP}`,
      )
    }
    const literalToken = this.next()
    if (literalToken.kind !== 'literal') {
      throw new UsageError(
        `--jq: expected a literal (string, number, true, false, null) after ${opToken.value} in "${this.source}". ${JQ_HELP}`,
      )
    }
    return { path, operator: opToken.value, literal: literalToken.value }
  }
}

export const parseJq = (expr: string): Step[] => {
  const tokens = tokenize(expr)
  return new Parser(tokens, expr).parseSteps()
}

const getField = (value: JsonValue, name: string): JsonValue => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new UsageError(
      `--jq: cannot read field '.${name}' of ${typeof value === 'object' ? 'null' : typeof value}`,
    )
  }
  const record = value as Record<string, JsonValue>
  return name in record ? record[name] : null
}

const getPath = (value: JsonValue, path: string[]): JsonValue =>
  path.reduce((current, segment) => getField(current, segment), value)

const evalComparison = (value: JsonValue, comparison: Comparison): boolean => {
  const actual = getPath(value, comparison.path)
  switch (comparison.operator) {
    case '==':
      return actual === comparison.literal
    case '!=':
      return actual !== comparison.literal
    case '<':
    case '<=':
    case '>':
    case '>=': {
      if (typeof actual !== 'number' || typeof comparison.literal !== 'number') {
        throw new UsageError(
          `--jq: ${comparison.operator} needs numbers on both sides, got ${JSON.stringify(actual)} and ${JSON.stringify(comparison.literal)}`,
        )
      }
      if (comparison.operator === '<') return actual < comparison.literal
      if (comparison.operator === '<=') return actual <= comparison.literal
      if (comparison.operator === '>') return actual > comparison.literal
      return actual >= comparison.literal
    }
    default:
      return false
  }
}

const evalBoolExpr = (value: JsonValue, expr: BoolExpr): boolean => {
  if (expr.kind === 'compare') {
    return evalComparison(value, expr.value)
  }
  if (expr.kind === 'and') {
    return evalBoolExpr(value, expr.left) && evalBoolExpr(value, expr.right)
  }
  if (expr.kind === 'or') {
    return evalBoolExpr(value, expr.left) || evalBoolExpr(value, expr.right)
  }
  return !evalBoolExpr(value, expr.value)
}

const compareForSort = (left: JsonValue, right: JsonValue): number => {
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right
  }
  const leftText = String(left)
  const rightText = String(right)
  if (leftText < rightText) return -1
  if (leftText > rightText) return 1
  return 0
}

const applyStep = (values: JsonValue[], step: Step): JsonValue[] => {
  if (step.op === 'identity') {
    return values
  }
  if (step.op === 'field') {
    return values.map((value) => getField(value, step.name))
  }
  if (step.op === 'iterate') {
    return values.flatMap((value) => {
      if (!Array.isArray(value)) {
        throw new UsageError(
          `--jq: cannot iterate over ${value === null ? 'null' : typeof value}, expected an array`,
        )
      }
      return value
    })
  }
  if (step.op === 'select') {
    return values.filter((value) => evalBoolExpr(value, step.test))
  }
  // sort_by: each element of `values` is expected to be an array to sort, matching jq's own
  // `sort_by` which operates on the array currently flowing through the pipe rather than on
  // each element individually.
  return values.map((value) => {
    if (!Array.isArray(value)) {
      throw new UsageError(
        `--jq: sort_by needs an array, got ${value === null ? 'null' : typeof value}`,
      )
    }
    return [...value].sort((left, right) =>
      compareForSort(getPath(left, step.path), getPath(right, step.path)),
    )
  })
}

// Runs the parsed pipeline against one root value, threading the current value(s) through
// each step the way jq's own pipe does: a step that iterates or selects can turn one value
// into many or few, and the next step runs over whatever came out.
export const runJq = (expr: string, root: unknown): unknown => {
  const steps = parseJq(expr)
  let values: JsonValue[] = [root as JsonValue]
  for (const step of steps) {
    values = applyStep(values, step)
  }
  // jq prints one line per result value; this CLI emits one JSON document, so a single
  // resulting value is unwrapped and several are returned as an array — the same shape
  // --fields already produces when a path crosses an array field.
  return values.length === 1 ? values[0] : values
}
