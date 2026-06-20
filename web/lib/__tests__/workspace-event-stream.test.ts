import test from "node:test"
import assert from "node:assert/strict"

import type { WorkspaceEventSource } from "../workspace-event-stream.ts"

import { WorkspaceEventStream } from "../workspace-event-stream.ts"

class FakeEventSource implements WorkspaceEventSource {
  onopen: ((event: Event) => void) | null = null
  onmessage: ((message: MessageEvent<string>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  closed = false
  readonly url: string

  constructor(url: string) {
    this.url = url
  }

  close(): void {
    this.closed = true
  }
}

test("WorkspaceEventStream opens once and forwards raw messages", () => {
  const sources: FakeEventSource[] = []
  const messages: string[] = []
  const stream = new WorkspaceEventStream(
    {
      canConnect: () => true,
      streamUrl: () => "/api/session/events?token=1",
      onOpen: () => {},
      onMessage: (data) => messages.push(data),
      onError: () => {},
    },
    (url) => {
      const source = new FakeEventSource(url)
      sources.push(source)
      return source
    },
  )

  stream.ensure()
  stream.ensure()
  sources[0]?.onmessage?.(new MessageEvent("message", { data: "{\"type\":\"turn_end\"}" }))

  assert.equal(sources.length, 1)
  assert.equal(sources[0]?.url, "/api/session/events?token=1")
  assert.deepEqual(messages, ["{\"type\":\"turn_end\"}"])
  assert.equal(stream.isOpen(), true)
})

test("WorkspaceEventStream reports first failure as error and connected failure as reconnecting", () => {
  const errors: string[] = []
  const opens: boolean[] = []
  const sources: FakeEventSource[] = []
  const stream = new WorkspaceEventStream(
    {
      canConnect: () => true,
      streamUrl: () => "/events",
      onOpen: ({ wasDisconnected }) => opens.push(wasDisconnected),
      onMessage: () => {},
      onError: ({ nextConnectionState }) => errors.push(nextConnectionState),
    },
    (url) => {
      const source = new FakeEventSource(url)
      sources.push(source)
      return source
    },
  )

  stream.ensure()
  sources[0]?.onerror?.(new Event("error"))
  sources[0]?.onopen?.(new Event("open"))
  sources[0]?.onerror?.(new Event("error"))

  assert.deepEqual(errors, ["error", "reconnecting"])
  assert.deepEqual(opens, [true])
})

test("WorkspaceEventStream respects canConnect and closes the active source", () => {
  let canConnect = false
  const sources: FakeEventSource[] = []
  const stream = new WorkspaceEventStream(
    {
      canConnect: () => canConnect,
      streamUrl: () => "/events",
      onOpen: () => {},
      onMessage: () => {},
      onError: () => {},
    },
    (url) => {
      const source = new FakeEventSource(url)
      sources.push(source)
      return source
    },
  )

  stream.ensure()
  assert.equal(sources.length, 0)

  canConnect = true
  stream.ensure()
  assert.equal(sources.length, 1)
  stream.close()
  assert.equal(sources[0]?.closed, true)
  assert.equal(stream.isOpen(), false)
})
