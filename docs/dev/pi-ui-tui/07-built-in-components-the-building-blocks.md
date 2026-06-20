# Built-in Components — The Building Blocks

Import from `@gsd/pi-tui`:

### Text

Multi-line text with automatic word wrapping and optional background.

```typescript
import { Text } from "@gsd/pi-tui";

const text = new Text(
  "Hello World\nSecond line",  // content (supports \n)
  1,                            // paddingX (default: 1)
  1,                            // paddingY (default: 1)
  (s) => bgGray(s)              // optional background function
);

text.setText("Updated content");  // Update text dynamically
```

**When to use:** Single or multi-line text blocks, styled labels, error messages.

### Box

Container with padding and background color. Add children inside it.

```typescript
import { Box } from "@gsd/pi-tui";

const box = new Box(
  1,                // paddingX
  1,                // paddingY
  (s) => bgGray(s)  // background function
);
box.addChild(new Text("Content inside a box", 0, 0));
box.setBgFn((s) => bgBlue(s));  // Change background dynamically
```

**When to use:** Visually grouping content with a colored background.

### Container

Groups child components vertically (stacked). No visual styling of its own.

```typescript
import { Container } from "@gsd/pi-tui";

const container = new Container();
container.addChild(component1);
container.addChild(component2);
container.removeChild(component1);
container.clear();  // Remove all children
```

**When to use:** Composing complex layouts from simpler components.

### Spacer

Empty vertical space.

```typescript
import { Spacer } from "@gsd/pi-tui";

const spacer = new Spacer(2);  // 2 empty lines
```

**When to use:** Visual separation between components.

### Markdown

Renders markdown with full formatting and syntax highlighting.

```typescript
import { Markdown } from "@gsd/pi-tui";
import { getMarkdownTheme } from "@gsd/pi-coding-agent";

const md = new Markdown(
  "# Title\n\nSome **bold** text\n\n```js\nconst x = 1;\n```",
  1,                    // paddingX
  1,                    // paddingY
  getMarkdownTheme()    // MarkdownTheme (from pi-coding-agent)
);

md.setText("Updated markdown content");
```

**When to use:** Rendering documentation, help text, formatted content.

### Image

Renders images in supported terminals (Kitty, iTerm2, Ghostty, WezTerm).

```typescript
import { Image } from "@gsd/pi-tui";

const image = new Image(
  base64Data,    // base64-encoded image data
  "image/png",   // MIME type
  theme,         // ImageTheme
  { maxWidthCells: 80, maxHeightCells: 24 }  // Optional size constraints
);
```

**When to use:** Displaying generated images, screenshots, diagrams.

### SelectList

Interactive selection from a list with search, scrolling, and descriptions.

```typescript
import { SelectList, type SelectItem } from "@gsd/pi-tui";

const items: SelectItem[] = [
  { value: "opt1", label: "Option 1", description: "First option" },
  { value: "opt2", label: "Option 2", description: "Second option" },
  { value: "opt3", label: "Option 3" },  // description is optional
];

const selectList = new SelectList(
  items,
  10,  // maxVisible (scrollable if more items)
  {
    selectedPrefix: (t) => theme.fg("accent", t),
    selectedText: (t) => theme.fg("accent", t),
    description: (t) => theme.fg("muted", t),
    scrollInfo: (t) => theme.fg("dim", t),
    noMatch: (t) => theme.fg("warning", t),
  }
);

selectList.onSelect = (item) => { /* item.value */ };
selectList.onCancel = () => { /* escape pressed */ };
```

**When to use:** Letting users pick from a list. Handles arrow keys, search filtering, scrolling.

### SettingsList

Toggle settings with left/right arrow keys.

```typescript
import { SettingsList, type SettingItem } from "@gsd/pi-tui";
import { getSettingsListTheme } from "@gsd/pi-coding-agent";

const items: SettingItem[] = [
  { id: "verbose", label: "Verbose mode", currentValue: "off", values: ["on", "off"] },
  { id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light", "auto"] },
];

const settingsList = new SettingsList(
  items,
  Math.min(items.length + 2, 15),  // maxVisible
  getSettingsListTheme(),
  (id, newValue) => { /* setting changed */ },
  () => { /* close requested (escape) */ },
  { enableSearch: true },  // Optional: fuzzy search by label
);
```

**When to use:** Settings panels, toggle groups, configuration UIs.

### Input

Text input field with cursor.

```typescript
import { Input } from "@gsd/pi-tui";

const input = new Input();
input.setText("initial value");
// Route keyboard input via handleInput
```

### Editor

Multi-line text editor with undo, word deletion, cursor movement.

```typescript
import { Editor, type EditorTheme } from "@gsd/pi-tui";

const editorTheme: EditorTheme = {
  borderColor: (s) => theme.fg("accent", s),
  selectList: {
    selectedPrefix: (t) => theme.fg("accent", t),
    selectedText: (t) => theme.fg("accent", t),
    description: (t) => theme.fg("muted", t),
    scrollInfo: (t) => theme.fg("dim", t),
    noMatch: (t) => theme.fg("warning", t),
  },
};

const editor = new Editor(tui, editorTheme);
editor.setText("prefilled");
editor.onSubmit = (value) => { /* enter pressed */ };
```

---
