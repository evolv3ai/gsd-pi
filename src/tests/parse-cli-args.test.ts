// gsd-pi — Unit tests for parseCliArgs (canonical CLI flag parser)
// Copyright (c) 2026 Jeremy McSpadden <jeremy@fluxlabs.net>

import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildHeadlessAutoArgs, parseCliArgs } from '../cli-web-branch.ts'

function parse(...args: string[]) {
  return parseCliArgs(['node', 'gsd', ...args])
}

describe('parseCliArgs — modes', () => {
  test('accepts mcp mode (added during refactor)', () => {
    assert.equal(parse('--mode', 'mcp').mode, 'mcp')
  })

  test('still accepts text/json/rpc modes', () => {
    assert.equal(parse('--mode', 'text').mode, 'text')
    assert.equal(parse('--mode', 'json').mode, 'json')
    assert.equal(parse('--mode', 'rpc').mode, 'rpc')
  })

  test('ignores unknown mode values', () => {
    assert.equal(parse('--mode', 'bogus').mode, undefined)
  })
})

describe('buildHeadlessAutoArgs', () => {
  test('preserves auto positional args without a model override', () => {
    const args = buildHeadlessAutoArgs({ messages: ['auto', 'next'] })
    assert.deepEqual(args, ['auto', 'next'])
  })

  test('forwards --model before auto positional args', () => {
    const args = buildHeadlessAutoArgs({
      model: 'claude-code/sonnet',
      messages: ['auto', 'next'],
    })
    assert.deepEqual(args, ['--model', 'claude-code/sonnet', 'auto', 'next'])
  })

  test('forwards --thinking before auto positional args', () => {
    const args = buildHeadlessAutoArgs({
      thinking: 'medium',
      messages: ['auto', 'next'],
    })
    assert.deepEqual(args, ['--thinking', 'medium', 'auto', 'next'])
  })
})

describe('parseCliArgs — worktree flag', () => {
  test('-w with no value sets worktree=true', () => {
    assert.equal(parse('-w').worktree, true)
  })

  test('--worktree with no value sets worktree=true', () => {
    assert.equal(parse('--worktree').worktree, true)
  })

  test('-w followed by a name captures the name', () => {
    assert.equal(parse('-w', 'feature-x').worktree, 'feature-x')
  })

  test('--worktree followed by a name captures the name', () => {
    assert.equal(parse('--worktree', 'feature-x').worktree, 'feature-x')
  })

  test('-w followed by another flag does not consume the flag', () => {
    const flags = parse('-w', '--print')
    assert.equal(flags.worktree, true)
    assert.equal(flags.print, true)
  })

  test('worktree is undefined when flag not passed', () => {
    assert.equal(parse('hello').worktree, undefined)
  })
})

describe('parseCliArgs — short flags and basic options', () => {
  test('-p sets print', () => {
    assert.equal(parse('-p').print, true)
  })

  test('--print sets print', () => {
    assert.equal(parse('--print').print, true)
  })

  test('-c sets continue', () => {
    assert.equal(parse('-c').continue, true)
  })

  test('--no-session sets noSession', () => {
    assert.equal(parse('--no-session').noSession, true)
  })

  test('--session and --session-dir capture forked session paths', () => {
    const flags = parse('--session', '/tmp/session.jsonl', '--session-dir', '/tmp/sessions')
    assert.equal(flags.session, '/tmp/session.jsonl')
    assert.equal(flags.sessionDir, '/tmp/sessions')
  })

  test('--model captures model id', () => {
    assert.equal(parse('--model', 'claude-opus-4-6').model, 'claude-opus-4-6')
  })

  test('--thinking captures thinking level without treating it as a message', () => {
    const flags = parse('--mode', 'json', '-p', '--thinking', 'medium', 'Task: evaluate gates')
    assert.equal(flags.thinking, 'medium')
    assert.deepEqual(flags.messages, ['Task: evaluate gates'])
  })

  test('--thinking rejects invalid levels', () => {
    assert.throws(
      () => parse('--thinking', 'ultra'),
      /Invalid thinking level "ultra"/,
    )
  })

  test('unknown options fail instead of turning their values into messages', () => {
    assert.throws(
      () => parse('--bogus', 'medium', 'Task: evaluate gates'),
      /Unknown option: --bogus/,
    )
  })

  test('subcommand-local options pass through to subcommand parsers', () => {
    const flags = parse('headless', '--bare', 'auto')
    assert.deepEqual(flags.messages, ['headless', '--bare', 'auto'])
  })

  test('`auto` does not pass through: --model/--thinking are parsed so buildHeadlessAutoArgs can reorder them', () => {
    const flags = parse('auto', '--model', 'test-model', '--thinking', 'medium')
    assert.deepEqual(flags.messages, ['auto'])
    assert.equal(flags.model, 'test-model')
    assert.equal(flags.thinking, 'medium')
    assert.deepEqual(buildHeadlessAutoArgs(flags), ['--model', 'test-model', '--thinking', 'medium', 'auto'])
  })
})

describe('parseCliArgs — list flags and accumulators', () => {
  test('--extension accumulates multiple values', () => {
    const flags = parse('--extension', 'a', '--extension', 'b')
    assert.deepEqual(flags.extensions, ['a', 'b'])
  })

  test('--tools splits comma-separated list', () => {
    assert.deepEqual(parse('--tools', 'read,write,edit').tools, ['read', 'write', 'edit'])
  })

  test('--list-models with no value sets to true', () => {
    assert.equal(parse('--list-models').listModels, true)
  })

  test('--list-models with provider filter captures provider', () => {
    assert.equal(parse('--list-models', 'anthropic').listModels, 'anthropic')
  })

  test('--list-models followed by another flag does not consume it', () => {
    const flags = parse('--list-models', '--print')
    assert.equal(flags.listModels, true)
    assert.equal(flags.print, true)
  })
})

describe('parseCliArgs — web mode flags', () => {
  test('--web with no path sets web=true', () => {
    const flags = parse('--web')
    assert.equal(flags.web, true)
    assert.equal(flags.webPath, undefined)
  })

  test('--web with a path captures it', () => {
    const flags = parse('--web', '/tmp/project')
    assert.equal(flags.web, true)
    assert.equal(flags.webPath, '/tmp/project')
  })

  test('--port parses valid integer', () => {
    assert.equal(parse('--port', '8080').webPort, 8080)
  })

  test('--port rejects non-numeric', () => {
    assert.equal(parse('--port', 'abc').webPort, undefined)
  })

  test('--port rejects out-of-range values', () => {
    assert.equal(parse('--port', '0').webPort, undefined)
    assert.equal(parse('--port', '70000').webPort, undefined)
  })

  test('--allowed-origins splits and trims comma list', () => {
    assert.deepEqual(
      parse('--allowed-origins', 'http://a.com, http://b.com ,http://c.com').webAllowedOrigins,
      ['http://a.com', 'http://b.com', 'http://c.com'],
    )
  })

  test('--no-auth captures opt-in web auth disablement', () => {
    assert.equal(parse('--web', '--no-auth').webNoAuth, true)
  })
})

describe('parseCliArgs — positional messages', () => {
  test('non-flag positional args become messages', () => {
    const flags = parse('hello', 'world')
    assert.deepEqual(flags.messages, ['hello', 'world'])
  })

  test('messages and flags can be interleaved', () => {
    const flags = parse('hello', '--print', 'world')
    assert.deepEqual(flags.messages, ['hello', 'world'])
    assert.equal(flags.print, true)
  })

  test('default messages and extensions are empty arrays', () => {
    const flags = parse()
    assert.deepEqual(flags.messages, [])
    assert.deepEqual(flags.extensions, [])
  })
})
