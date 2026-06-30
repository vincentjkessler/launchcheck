# LaunchCheck

Part of the **Free Vibe Coding Safety Tools** kit.

LaunchCheck helps vibe coders test the thing they are about to ship.

You give it a ZIP file or an HTML app. It checks the build, makes a report, and writes a repair note you can paste into your next AI coding chat.

It is for this moment:

> "My AI says the app is done. Is it really done?"

Use LaunchCheck after the build exists and before you share it.

## Demo

Watch the short demo:

[`demo/recordings/launchcheck-demo.webm`](demo/recordings/launchcheck-demo.webm)

Record it again:

```powershell
npm run record:demo
```

## What LaunchCheck Does

LaunchCheck looks for common ship blockers:

- missing files
- broken ZIP structure
- JavaScript syntax errors
- browser console errors
- failed requests
- mobile, tablet, and desktop layout problems
- missing text or buttons you said should exist
- weak release signs
- repeat problems between builds

It does not run random apps, installers, scripts, or EXE files from a download. It treats every build like it might be unsafe.

## What You Need

- Node.js 20 or newer
- PowerShell on Windows
- A ZIP file or HTML file you want to check

For full browser checks, install Chromium:

```powershell
npm install
npx playwright install chromium
```

For a first simple check, you can skip Chromium and use `--no-browser`.

## The Fastest Way To Use It

Open PowerShell in the LaunchCheck folder.

Install the project:

```powershell
npm install
```

Check a ZIP:

```powershell
node .\bin\launchcheck.js validate "C:\Path\To\your-build.zip"
```

Check one HTML file:

```powershell
node .\bin\launchcheck.js validate "C:\Path\To\index.html"
```

Run a simple static check only:

```powershell
node .\bin\launchcheck.js validate "C:\Path\To\your-build.zip" --no-browser
```

## What You See After It Runs

LaunchCheck prints something like this:

```text
[LaunchCheck] PASS: index.html
[LaunchCheck] Score: 69/100
[LaunchCheck] Verdict: Acceptable for Human Review
[LaunchCheck] Report: C:\...\validator-report.html
[LaunchCheck] AI packet: C:\...\ai-iteration-packet.txt
```

Open the HTML report first:

```text
validator-report.html
```

Paste this file into your next AI coding chat when you want fixes:

```text
ai-iteration-packet.txt
```

That packet is the main handoff. It tells the AI what failed, what changed, and what to fix next.

## What Result Means

**Ready for Release**

The build looks good enough to ship based on the checks.

**Acceptable for Human Review**

The build may be okay, but you should read the report before shipping.

**Needs Repair**

Do not ship yet. Give the AI packet to your coding agent and run LaunchCheck again after the fix.

## What Should I Check?

Use LaunchCheck on the final build, not your messy source folder.

Good inputs:

- the ZIP you plan to send
- the `index.html` file for a one-page app
- a fresh build dropped into Downloads

Bad inputs:

- your whole dev folder
- `node_modules`
- random installer files
- code you are not ready to test yet

## Watch Your Downloads Folder

Watch mode is useful when your AI tool keeps making new ZIP files.

```powershell
node .\bin\launchcheck.js watch --watch "$HOME\Downloads"
```

Now drop a new ZIP or HTML file into Downloads. LaunchCheck will test it when the copy is done.

On Windows, you can also run:

```powershell
.\Start-LaunchCheck.ps1
```

LaunchCheck ignores old files when watch mode starts. It checks new files.

## Where Reports Go

LaunchCheck makes these folders beside the file it checked:

- `_VALIDATION_REPORTS`
- `_VALIDATION_STATE`
- `_VALIDATION_WORK`
- `_VALIDATED_BUILDS`

Start in `_VALIDATION_REPORTS`.

Look for:

- `validator-report.html`
- `ai-iteration-packet.txt`

## Optional: Tell LaunchCheck What Your App Must Do

You can add a `launchcheck.qa.json` file to your build.

You do not need this for your first run.

Use it when you want checks like:

- the page must say "Export"
- the Start button must exist
- clicking a button must show new text
- a function must exist on `window`

Templates are in [`templates`](templates).

## Commands

```text
launchcheck validate <zip-or-html>
launchcheck watch --watch <folder>
launchcheck status
```

Help:

```powershell
node .\bin\launchcheck.js help
```

## Test LaunchCheck Itself

```powershell
npm test
npm run test:syntax
```

## Safety

LaunchCheck opens HTML in a browser test and reads files from ZIPs. It does not auto-run random native programs.

The public release also does not self-update. If you download a newer LaunchCheck ZIP, it will be treated like any other build to inspect. It will not replace the copy you are running.

Still, only test builds you trust enough to inspect.

## License

MIT. See [LICENSE](LICENSE).
