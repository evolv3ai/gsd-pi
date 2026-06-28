#!/bin/bash
# claude-code-send-selection.sh
# macOS Quick Action shim: highlight text in Claude Code app → submit it as chat input.
# Setup: Automator → Quick Action → "Run Shell Script" → paste this path → bind a hotkey.

# Automator pipes selected text via stdin; fallback to clipboard
if [ -t 0 ]; then
  TEXT=$(pbpaste)
else
  TEXT=$(cat)
fi

# Strip leading/trailing whitespace
TEXT=$(echo "$TEXT" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
[ -z "$TEXT" ] && exit 0

# Stash clipboard, we'll restore it after
ORIG_CLIP=$(pbpaste)
echo -n "$TEXT" | pbcopy

osascript <<'EOF'
tell application "System Events"
  -- Find the Claude Code process (Electron app name varies)
  set frontApp to name of first application process whose frontmost is true

  -- If Claude Code isn't frontmost, try to activate it
  if frontApp does not contain "Claude" then
    try
      tell application "Claude" to activate
      delay 0.3
    on error
      try
        tell application "Claude Code" to activate
        delay 0.3
      end try
    end try
  end if

  -- Escape key clears any selection/modal, focuses input
  key code 53
  delay 0.1

  -- Paste and submit
  keystroke "v" using command down
  delay 0.1
  keystroke return
end tell
EOF

# Restore original clipboard after a beat
sleep 0.5
echo -n "$ORIG_CLIP" | pbcopy
