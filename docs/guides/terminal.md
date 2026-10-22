# Terminal attach: read and write mode

The terminal sheet (spec [29](../specs/29-terminal-attach.md)) shows a live
agent session in the browser through xterm.js. It opens **read-only**; **Take
control** switches it to **write** mode until the person hands control back or
closes the sheet.

## What reaches the session

- **Read mode** sends nothing. The terminal has `disableStdin` set and the
  page does not listen to its input, so neither keys nor anything the
  terminal itself produces go to the runner.
- **Write mode** forwards everything xterm.js emits as input (`onData` and
  `onBinary` in `apps/web/src/components/terminal/terminal-view.tsx`) to the
  session's PTY, while the view is live — not while the scroll-back history is
  open (#522).

## Terminal auto-replies (security audit W8-08)

A terminal answers some control sequences on its own. When the program in the
session prints a query, xterm.js writes the answer to its input, exactly as if
it had been typed:

- device attributes (`ESC [ c`) and device status / cursor position
  (`ESC [ 5 n`, `ESC [ 6 n`);
- mode reports (`DECRQM`) and colour queries (`OSC 10` / `OSC 11`);
- focus in and out (`ESC [ I`, `ESC [ O`) and bracketed paste markers, when
  the program turned them on.

In write mode these answers are forwarded like keystrokes. This is how every
terminal emulator behaves and full-screen programs such as Claude Code rely on
it, so Nautelle does not filter them.

What this means for a person in control:

- Text the session prints can make the terminal send a short, fixed-format
  reply into the session's input. If a shell prompt is waiting, the reply can
  appear on the command line as stray characters such as `^[[?1;2c`; press
  Ctrl+C or clear the line before you type a command.
- A reply never carries text chosen by the session: xterm.js leaves the
  window-title and other report options that echo arbitrary text switched off,
  so output cannot type a command through the terminal.
- Read mode is unaffected: nothing is sent, so watching a session never
  writes to it. Stay in read mode unless you mean to type.
