# Claude Workflow — the desktop app

    dist\ClaudeWorkflow-1.3.1-portable.exe   one file, no install, runs from a USB stick
    dist\ClaudeWorkflow-1.3.1-setup.exe      installer, adds a Start-menu entry

Both are about 100 MB and need nothing on the target PC — no Node, no npm, no browser.

## Running it on a machine that is not yours

The portable build installs nothing: copy it, double-click it, delete it. It unpacks itself
to a temporary directory on each launch, which is why the first window takes about half a
minute to appear. One thing on an unfamiliar machine used to stop it dead, and no longer does:

- **A system proxy with no loopback exception.** The window and the server live in the same
  process and talk over `127.0.0.1`, but Chromium obeys the system proxy, and a managed
  Windows install often has one that cannot route loopback. The result was
  `ERR_FAILED (-2) loading 'http://127.0.0.1:7392/'` — the app failing to reach itself. The
  window now forces a direct connection for its own session and retries the first load.
  If it still cannot get through, the message says so in those words and points at the two
  things that fix it, instead of showing a Chromium stack trace.
What it still needs from the machine: a way to sign in. With Claude Code already installed
there is nothing to do. Without it, `ant` or an API key — see below.

**One failure the app cannot fix from the inside.** If `ELECTRON_RUN_AS_NODE` is set in the
environment, the packaged binary behaves as plain Node and **never loads the app's own
startup file** — so no message, no window, nothing. Verified:

    ELECTRON_RUN_AS_NODE=1 "Claude Workflow.exe" -e "console.log('as node')"
    as node

Because none of the app's code runs, no guard inside it can help; the app's own relaunch
guard only covers the unpackaged development path. The variable leaks out of some parent
processes — VS Code's integrated terminal among them, which is how this was found. Starting
the app from Explorer, the Start menu, or a shortcut never has it. From a terminal that
does, clear it first:

    set ELECTRON_RUN_AS_NODE=     &&  "ClaudeWorkflow-1.3.1-portable.exe"

**The version is shown in the title bar, beside the name.** Check it matches the file you
meant to run. An old copy left behind in `C:\Program Files` looks identical from the
outside, and the way that presents is a button that does nothing.

## Signing in

On a first run the app opens the sign-in dialog by itself, and the title bar says
**Sign in to Claude** until you have. You can reopen it any time from that button, from
**File ▸ Settings…**, or with `Ctrl+,`. Three ways in:

**Use the Claude Code login already on this PC** — nothing to do, and the one most people
want. If Claude Code is installed (the VS Code extension is enough — its own copy of the
binary counts), the app finds it and runs every stage through it. You are already signed
in, so there is no second login, no key, and no credential stored here at all.

> The app does not read anyone's credential files. It runs the `claude` binary as a
> subprocess, exactly as you would in a terminal, and the CLI authenticates itself. This
> is the documented way to drive the agent loop from outside Python and TypeScript.

Two things follow from it. Usage counts against the **plan you are signed in to**, not
against API credit. And each stage carries roughly **20,000 tokens** of Claude Code's own
scaffolding on top of the actual prompt, so this route consumes a plan noticeably faster
than the API route consumes credit. Settings lets you choose per machine: use it when
available, always use it, or never.

**Sign in with Claude** — the browser route. It runs `ant auth login`, which opens
your browser once. The login is stored for the whole machine, under
`%APPDATA%\Anthropic`, and every Anthropic tool on that PC picks it up. Nothing is kept
inside the app. It needs the `ant` CLI, which is a separate download:

| | |
|---|---|
| Windows | download `ant.exe` from github.com/anthropics/anthropic-cli/releases, put it on your PATH |
| macOS | `brew install anthropics/tap/ant` |
| Linux | download the release for your architecture |

The app checks for `ant` at startup. Without it the **Sign in** button is disabled and the
dialog explains why, with a link that opens the download page in your real browser — so
the dead button is never a dead end. **If you have not installed `ant`, the API key below
is the only route that will work**, and it works on its own.

`ant auth login` bills API credit rather than a Claude subscription, which is the main
reason to choose it over the Claude Code route above.

> An earlier version of this page said the app *could not* use the Claude Code login on
> this PC, citing the Agent SDK's rule about third-party products offering claude.ai
> login. That rule is about offering claude.ai login **to your product's users**. It does
> not cover running the official CLI as a subprocess under your own account, which is
> documented and supported — and is what the first route does. The app still reads nobody's
> credential files.

**Paste an API key** — the fallback. The key is encrypted with the OS keychain (DPAPI on
Windows, Keychain on macOS, libsecret on Linux) before it touches disk. If encryption is
unavailable the app stores it in plain text **and says so** in Settings rather than
hiding it.

> A pasted key silently outranks a browser login, and an *empty* `ANTHROPIC_API_KEY` still
> wins its precedence slot and authenticates as an empty key. The app therefore deletes the
> variable rather than blanking it. To go back to a browser login after using a key, clear
> the key field and save.

## Using it

Paste the requirement. There are three ways to attach images, and they all end up in the
same place:

- **Click the image area** and pick files in the ordinary dialog. Use this over a remote
  desktop, where dragging a file in from your own machine is not possible.
- **Drop files onto it.**
- **Press `Ctrl+V`** — anywhere in the window, not only in the text box — and several
  screenshots at once if the clipboard holds them.

Every image travels with the task, so each step reads the original rather than somebody's
transcription of it.

**Text and images go together.** Type or paste the requirement *and* attach screenshots;
both reach every stage — the classifier, the worker and both reviewers each see the words
and the pictures. Neither one replaces the other.

There is no length limit on the requirement text. It is written to a file, never onto a
command line.

Two things worth knowing:

- Pasting while the **Sign in** dialog is open does nothing on purpose. That dialog is
  modal and covers the form, so an attachment made there would land somewhere you cannot
  see it. Close it first.
- Attachments must be **PNG, JPEG, GIF or WebP** — the formats the API reads as images.
  Anything else is refused at the point you drop it, with a message, rather than being
  attached and then quietly skipped on the way to the model.

**You can choose the model for each step.** By default an analyst stage reads the
requirement and picks one, which is usually right. Open **Models** in the new-ticket form to
pin any of the five steps — classify, pick model, do the work, review, write result — to
`opus`, `sonnet`, `haiku` or `fable`. `Auto` hands that step back to the analyst. Pinning
*both* the worker and the reviewers skips the analyst call altogether, because there is
nothing left for it to decide and no reason to pay for it. Reviewers are still never weaker
than the worker; the ledger refuses that and raises them instead. A running ticket has the
same five controls under **Models for this ticket**, and a change there applies to the next
step and to every retry.

**You can add an instruction while it is running.** Under the activity log there is a box
for something you forgot or want to correct. It is added to the requirement, marked as
having arrived late, and every stage from that point on sees it — including both reviewers
and every retry.

> It cannot change a call already in flight. That request was sent before you typed, and the
> only thing that ends it is **Stop**. Measured, on a ticket told mid-work to answer in
> French: the worker finished in English, *both reviewers failed it for ignoring the
> instruction and quoted it back*, and the retry delivered `Rouge / Vert / Bleu`. So it
> works — by way of the next stage, not the current one. Give the ticket a spare attempt if
> you expect to use this.

**Several tickets can run at once.** Press **Run it** and start another straight away —
each has its own ledger entry, its own workspace and its own lock, and they make progress
independently. Click any ticket in the list to watch that one. `Ctrl+Enter` in the
requirement box starts a run without reaching for the button.

**The five numbers in the title bar** are calls, input tokens, output tokens, cache reads,
and dollars, in that order. They move while a run is in flight and survive a restart.
Each ticket also carries its own cost, in the list and on the result.

**A run takes ten to fifteen minutes.** The ticket shows a ticking clock so you can tell
thinking from hung, and the activity log timestamps every step. Long stretches of model
reasoning are clamped to one line — click any of them to read the whole thing. Scrolling
back to an earlier stage will not be undone by the next update.

**Stop** ends a run you started by mistake. It kills the model call outright rather than
waiting for the turn to finish, keeps every stage that already completed, and turns into
**Resume** so the ticket picks up where it stopped. **Delete** removes a finished ticket
along with its workspace; it is refused while a run is in flight.

**Closing the app stops what it was paying for.** A stage runs as a `claude` child
process, and on Windows a child does not die with its parent, so this is not automatic:
quitting kills the calls it started on the way out, and the next start clears anything a
crash or an End Task left behind. Nothing is ever identified by process name — the app
tracks the pids it started itself, in `running.json` beside the ledger. That distinction
matters on a machine where you also use Claude Code: `claude.exe` is *your* session too,
and a tidy-up that went by name would end it. (Measured along the way: the child usually
dies anyway when its parent does, because its output pipe closes. The cleanup is the
backstop for when it does not.)

Then press **Run it** and watch. Classify → pick a model → do the work → two independent
reviews → retry on failure → the result, with a Copy button.

**When it finishes, it tells you.** A run takes ten to twenty minutes and nobody watches
it, so the end arrives rather than being discovered: a desktop notification, and the result
opens full screen over the whole window with the numbered steps for uploading it and the
exact text to paste. Copy the text, close it, carry on. The **Full screen** button on any
finished ticket opens the same view again later.

An escalation opens the same way but says the opposite: its first line is that nothing here
is ready to submit, and its steps send you to the write-up rather than to a form.

**The result is plain text.** No `**bold**`, no `#` headings, no `*` bullets, no backticks
around words — a form has no Markdown renderer, so every one of those characters would show
up literally and you would have to clean them out by hand. The result roles are told to
write plain text, and the payload is then cleaned before you see it, which the activity log
records. Code is left exactly as written: anything inside a fenced or indented block is
copied through untouched, and so is a lone asterisk, a glob like `src/*.js`, or a
multiplication sign.

## When a run stops early

The activity log says which of these happened, and what to do about it:

| | |
|---|---|
| **The model declined the prompt** | Its safeguards flagged the request. Retrying cannot change that — reword the requirement and start a new ticket. |
| **Rate or usage limit** | Wait, then **Run again**. Nothing is lost; the ticket resumes from its last finished stage. |
| **Credential rejected** | Open Settings and check the route. |
| **Model overloaded** | **Run again** in a minute. |
| **Hit the turn limit** | Not fatal. The work produced so far is kept and goes to the reviewers, who decide whether it is good enough. |

A ticket that fails review is *not* an error. It retries with the reviewers' defects
attached, up to the attempt cap. If it runs out of attempts you get an honest write-up of
what was tried and why it failed, rather than an answer nobody checked.

## Where things live

| | |
|---|---|
| Ledger, workspaces, settings | `%APPDATA%\Claude Workflow` (File → Open data folder) |
| Sign-in profile | `%APPDATA%\Anthropic` — shared with every Anthropic tool |

The install directory is read-only once packaged, which is why nothing is written beside
the executable.

## Building it yourself

    npm install
    npm run icon        # regenerates build/icon.png and build/icon.ico
    npm run dist        # Windows  -> dist/
    npm run dist:mac    # must be run ON a Mac
    npm run dist:linux  # must be run on Linux

macOS and Linux binaries cannot be produced from Windows; the config for them is ready,
but the build has to happen on that OS.

Two build details worth not undoing:

- **`asar` is on, with `bin/**` unpacked.** `engine.mjs` spawns `bin/relay.mjs` as a child
  Node process, and a child has no asar support — it can only read a real file on disk.
  With asar off entirely, the portable target has to extract ~10k loose files on every
  launch and fails to start.
- **The child process's `cwd` is the data directory, not the app directory.** Once packaged
  the app directory *is* `app.asar`, a file; handing that to a child as a working directory
  fails with a bare `ENOENT` that reads like the executable is missing.

## Checks

    npm run smoke                                          # 20 checks, no API calls
    node desktop\packaged-test.mjs                                   # the BUILT app
    node desktop\concurrent-test.mjs                                 # several at once
    node desktop\inputs-test.mjs                                     # model pins, addenda
    node desktop\plain-test.mjs                                      # formatting removal
    node desktop\cancel-test.mjs                                     # does Stop stop?
    node desktop\orphan-test.mjs                                     # does quitting stop?
    node_modules\electron\dist\electron.exe desktop\ui-test.cjs      # every screen state
    node_modules\electron\dist\electron.exe desktop\login-test.cjs   # is there a way in?
    node_modules\electron\dist\electron.exe desktop\paste-test.cjs   # real Ctrl+V

The three Electron-launched tests need **`ELECTRON_RUN_AS_NODE` unset**. Some parents leak
it — VS Code's integrated terminal among them — and with it set the Electron binary runs
as plain Node, `require('electron')` hands back a path string, and every one of these dies
on `Cannot read properties of undefined (reading 'whenReady')`. In bash: `env -u
ELECTRON_RUN_AS_NODE ...`.

`packaged-test.mjs` is the only test that launches the real executable and talks to it
over the DevTools protocol. Every other test builds its own window and loads the page
into it, which skips `desktop/main.cjs` entirely — and, more importantly, cannot tell a
fixed build from a stale one. A broken `app.asar` sitting in `C:\Program Files` looks
identical from the outside. Run this one before believing a fix shipped.

`login-test.cjs` exists because the app once shipped with **no usable sign-in at all**:
the button was wired by a function that had been truncated out of `app.js`, so clicking
it did nothing and the dialog never opened by itself either. Every other test passed.
Nothing had asked the question a person asks first — *how do I log in?*

`smoke.mjs` exists because the SDK's zod helpers fail at *call* time, not import time —
`node --check` sees nothing wrong. It builds every schema and tool and exercises the
ledger's guards.

`paste-test.cjs` drives the app the way a person does: PowerShell puts a real bitmap on
the Windows clipboard (`setclip.ps1`, the way the Snipping Tool would), and `Ctrl+V` goes
in through Chromium's own input pipeline. An earlier version dispatched synthetic
clipboard events instead. It passed while the app was badly broken — a script error was
stopping most of `app.js` from ever running, and a test that calls the handler directly
cannot see that. Its **first** check is now that the page loaded with no console error,
because that single failure disables everything downstream of it.

## Known limits

- **First launch takes ~30 seconds** for the portable build: it extracts itself to a temp
  directory each time. The installed build starts immediately.
- **`ELECTRON_RUN_AS_NODE`** in the environment makes the Electron binary behave as plain
  Node and the app will not start. It prints a line saying exactly that. Some parent
  processes (other Electron apps, some terminals) leak it.
- **The window is unsigned.** Windows SmartScreen will warn on first run — "More info" →
  "Run anyway". Signing needs a certificate you would have to buy.
- **Run commentary is in memory.** Task state survives a restart; the activity log does
  not. Press **Run again** and the engine resumes from the recorded state.
- **`paste-test.cjs` needs a live desktop session.** Over a locked or disconnected RDP
  session no keystroke reaches any window, so it reports SKIPPED rather than pretending
  the app is broken.
- **A key stored encrypted can only be read back by the app that stored it.** If
  `safeStorage` is unavailable on a later run — a different machine, a different Windows
  account — Settings still shows a key as saved, but it cannot be decrypted. Clear the
  field, save, and paste the key again.
