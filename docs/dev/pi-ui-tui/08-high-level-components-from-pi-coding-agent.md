# High-Level Components from pi-coding-agent

### DynamicBorder

A horizontal border line with themed color. Use for framing dialogs.

```typescript
import { DynamicBorder } from "@gsd/agent-modes";

// ⚠️ MUST explicitly type the parameter as string
const border = new DynamicBorder((s: string) => theme.fg("accent", s));
```

### BorderedLoader

Spinner with cancel support. Shows a message and an animated spinner while async work runs.

```typescript
import { BorderedLoader } from "@gsd/agent-modes";

const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
  const loader = new BorderedLoader(tui, theme, "Fetching data...");
  loader.onAbort = () => done(null);  // Escape pressed

  // Do async work with the loader's AbortSignal
  fetchData(loader.signal)
    .then(data => done(data))
    .catch(() => done(null));

  return loader;
});
```

### CustomEditor

Base class for custom editors that replace the input. Provides app keybindings (escape to abort, ctrl+d, model switching) automatically.

```typescript
import { CustomEditor } from "@gsd/agent-modes";

class MyEditor extends CustomEditor {
  handleInput(data: string): void {
    // Handle your keys first
    if (data === "x") { /* custom behavior */ return; }
    // Fall through to CustomEditor for app keybindings + text editing
    super.handleInput(data);
  }
}
```

---
