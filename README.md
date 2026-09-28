# ff

A single-page live dashboard for my fantasy football matchups across ESPN, Yahoo, and Sleeper. One card per league
shows my score vs. my opponent, projections where the platform has them, and how many starters are still to play.
It refreshes every 30 seconds.

See [PLAN.md](PLAN.md) for the implementation plan and status.

| League  | Status                                                 |
| ------- | ------------------------------------------------------ |
| Sleeper | Live data                                              |
| ESPN    | Live data, projections, real NFL game states           |
| Yahoo   | Mock data until [Step 4](docs/step-4-kickoff.md) lands |

## Running

Requires Node 24 (pinned in `.nvmrc`). With [fnm](https://github.com/Schniz/fnm) set up, `cd`-ing into the repo
switches to it automatically.

```sh
npm ci                 # install exactly what package-lock.json pins
cp .env.example .env   # then fill in the leagues you want (see below)
npm run dev            # http://localhost:3000, restarts on file changes
```

Leagues whose settings are blank are left off the page, and the startup log lists which ones are active. If one
league fails (bad ID, expired cookies, API down), its card shows the error and the others keep working.

## Configuration

All settings live in `.env` (gitignored). `.env.example` lists every variable.

### Sleeper

| Variable            | Where to find it                             |
| ------------------- | -------------------------------------------- |
| `SLEEPER_LEAGUE_ID` | The number in `sleeper.com/leagues/<id>/...` |
| `SLEEPER_USERNAME`  | Your Sleeper username (case doesn't matter)  |

The first request downloads Sleeper's player list (~5MB), trims it to names and positions, and caches it in
`.cache/sleeper-players.json` for 24 hours.

### ESPN

| Variable         | Where to find it                                                                |
| ---------------- | ------------------------------------------------------------------------------- |
| `ESPN_LEAGUE_ID` | `leagueId=` in your league page's URL                                           |
| `ESPN_TEAM_ID`   | `teamId=` in your team page's URL. Required unless `ESPN_SWID` identifies you   |
| `ESPN_SEASON`    | Optional; defaults to the current NFL season                                    |
| `ESPN_S2`        | Private leagues only: the `espn_s2` cookie from a logged-in browser on espn.com |
| `ESPN_SWID`      | Private leagues only: the `SWID` cookie, including its `{braces}`               |

ESPN's fantasy API is unofficial. If the card says access was denied, check the league ID and season, and for a
private league copy fresh cookies (they expire).

### Yahoo

Coming in Step 4: it needs a Yahoo developer app and a one-time `npm run yahoo:auth` login.

### Server

| Variable    | Meaning                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------- |
| `HOST`      | Address to listen on. `127.0.0.1` (default): this machine only. `0.0.0.0`: whole network |
| `PORT`      | Defaults to `3000`                                                                       |
| `LOG_LEVEL` | `info` by default; `debug` for more detail, `warn` for less                              |

## Running on a home server (Windows)

An always-on Windows PC on the home network can run the dashboard, so any phone, tablet or laptop in the house can
open it without the server running on a laptop. An old desktop is plenty: the server uses little CPU and memory.

The server runs as a Windows service, using [WinSW](https://github.com/winsw/winsw) and
[`deploy/windows/ff-service.xml`](deploy/windows/ff-service.xml). That means it starts at boot without anyone
logging in, restarts after a crash, and writes logs to `C:\ff\logs`.

Run the commands below in **PowerShell as administrator** (right-click Start → Terminal (Admin)), or over SSH once
step 3 is done. The repo lives at `C:\ff`, outside your user folder, so the service account can read it.

### 1. Check the machine

Settings → System → About should show **64-bit** Windows 10 or 11. Note the RAM too: the dashboard needs well under
1 GB, but Claude Code (step 10) wants 4 GB or more.

### 2. Keep it on and reachable

- **Network:** use Ethernet if you can. Set the connection to **Private** (Settings → Network & internet → Ethernet
  → Network profile type), which is what the firewall rule in step 5 applies to.
- **No sleep:** a sleeping PC serves nothing.
  ```powershell
  powercfg /change standby-timeout-ac 0
  powercfg /change hibernate-timeout-ac 0
  ```
- **Power cuts:** in the BIOS (usually F10 at boot on HP desktops), set "After Power Loss" / "AC power recovery"
  to **On**, so it boots by itself when power comes back.
- **A memorable name:** `Rename-Computer -NewName ff-server -Restart`.
- **Windows Update:** set active hours (Settings → Windows Update → Advanced options) so restarts happen
  overnight. The service starts again by itself after a reboot.

### 3. Remote access from a Mac (optional)

With Windows' built-in OpenSSH server, you can do the rest of this from another computer:
`ssh <user>@ff-server.local`. Here `<user>` is the part after the backslash in `whoami`.

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0   # also adds a firewall rule for port 22
Set-Service sshd -StartupType Automatic
Start-Service sshd
```

**Log in with an SSH key.** If you sign in to Windows with a Microsoft account and a PIN or passkey, you may have no
usable password at all (the PIN only works at the PC's own keyboard), so a key is the only way in. On the Mac,
`pbcopy < ~/.ssh/id_ed25519.pub` copies your public key (create one first with `ssh-keygen -t ed25519` if it's
missing). It's one line starting with `ssh-ed25519`, and it's safe to share, so move it to the PC any way you like:
a note in your password manager, an email to yourself. Never copy `id_ed25519` without `.pub`: that's the private
key.

For an **administrator** account (the usual case; check with `net localgroup Administrators`), Windows ignores
`~\.ssh\authorized_keys` and reads a shared file instead, which must be readable only by admins. Run this at the
PC, in a terminal that really is elevated (its prompt starts in `C:\Windows\system32`, not your user folder):

```powershell
Set-Content C:\ProgramData\ssh\administrators_authorized_keys 'ssh-ed25519 AAAA...your key...'
Get-Content C:\ProgramData\ssh\administrators_authorized_keys   # should print your key line
icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"
Restart-Service sshd
```

`Set-Content` replaces the file; use `Add-Content` to add a second key later. `ssh <user>@ff-server.local` from the
Mac should now log in without a password prompt. If it still asks for a password, the key wasn't accepted:
`Get-WinEvent -LogName OpenSSH/Operational -MaxEvents 10 | Format-List TimeCreated, Message` on the PC usually says
why. (Don't get the key from `https://github.com/<you>.keys` unless you've checked your Mac's key is listed there;
if it isn't, that writes an empty file.)

Once key login works, turn off password login, and check from a second terminal that you can still get in before
closing the first:

```powershell
(Get-Content C:\ProgramData\ssh\sshd_config) -replace '^#?PasswordAuthentication .*', 'PasswordAuthentication no' |
  Set-Content C:\ProgramData\ssh\sshd_config
Restart-Service sshd
```

SSH sessions from an administrator account already run elevated, so the admin-only commands below work over SSH.
They open in `cmd.exe`; type `powershell` to switch, or make PowerShell the default:

```powershell
New-ItemProperty -Path HKLM:\SOFTWARE\OpenSSH -Name DefaultShell -PropertyType String -Force `
  -Value C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
```

### 4. Install Git and Node, clone and build

Node is installed system-wide (under `C:\Program Files\nodejs`), not with fnm or nvm-windows. Those install per
user, where the service account can't reach them.

```powershell
# the --accept flags answer winget's license prompts up front, which can otherwise hang over SSH
winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
# reload PATH in this session so it finds git and node (or open a new window)
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
node --version                 # v24 or newer
git config --global credential.gitHubAuthModes device
git clone <this repo's URL> C:\ff
cd C:\ff
npm ci                         # includes dev dependencies: the TypeScript compiler is needed to build
Copy-Item .env.example .env
notepad .env                   # fill in your leagues, and set HOST=0.0.0.0
npm run build                  # compiles src\ to dist\
```

Over SSH, the Node installer can close your connection partway through ("Connection to ff-server.local closed by
remote host"). The install still finishes: reconnect and check `node --version`.

If the repo is private, Git asks you to sign in to GitHub on the first clone. The `gitHubAuthModes device` line
makes it print a short code instead of opening a browser on the PC, which you can't see over SSH: enter the code at
github.com/login/device on any computer. To deploy a branch that isn't merged yet, add `-b <branch>` to the clone;
later, `git -C C:\ff switch main` moves it back.

With SSH set up, copy your laptop's `.env` over instead of retyping it: from the project folder on the laptop,
`scp .env <user>@ff-server.local:C:/ff/.env`. Don't commit it. Notepad can't open over SSH, so set `HOST` from the
command line:

```powershell
$f = 'C:\ff\.env'; $c = Get-Content $f
if ($c -match '^HOST=') { $c -replace '^HOST=.*', 'HOST=0.0.0.0' | Set-Content $f } else { Add-Content $f 'HOST=0.0.0.0' }
Select-String '^HOST=' $f      # HOST=0.0.0.0
```

`HOST=0.0.0.0` makes the server listen on the PC's network interfaces instead of loopback only. Without it, the
dashboard only answers requests made on the PC itself. At startup the log prints the URLs it's reachable at, plus a
warning that it's open to the network.

If git later says "detected dubious ownership", run `git config --global --add safe.directory C:/ff`. Git
refuses to work in folders owned by another account, and a folder created from an admin shell is owned by the
Administrators group.

### 5. Open the firewall and try it

A background service never gets Windows' "allow access?" popup, so allow port 3000 explicitly. Allow it on
**Private** networks only:

```powershell
New-NetFirewallRule -DisplayName "ff dashboard" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
npm start                      # then open http://<pc's address>:3000 on your phone; Ctrl+C to stop
```

### 6. Install the service

```powershell
# WinSW reads the .xml with the same name as the .exe, so save it as ff-service.exe next to ff-service.xml.
# Hiding the progress bar makes the download much faster in Windows PowerShell 5.1.
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe `
  -OutFile C:\ff\deploy\windows\ff-service.exe -UseBasicParsing

# The service runs as LocalService, a built-in low-privilege account: let it read the repo and write its folders
New-Item -ItemType Directory -Force C:\ff\.cache, C:\ff\.tokens, C:\ff\logs | Out-Null
icacls C:\ff /grant "NT AUTHORITY\LocalService:(OI)(CI)RX"
icacls C:\ff\.cache /grant "NT AUTHORITY\LocalService:(OI)(CI)M"
icacls C:\ff\.tokens /grant "NT AUTHORITY\LocalService:(OI)(CI)M"
icacls C:\ff\logs /grant "NT AUTHORITY\LocalService:(OI)(CI)M"

C:\ff\deploy\windows\ff-service.exe install
Start-Service ff
Get-Service ff                                               # Status: Running
Get-Content C:\ff\logs\ff-service.out.log -Wait -Tail 20     # follow the log; Ctrl+C to stop following
```

Logs are JSON (pino's format), one line per entry. For readable output, append `| npx pino-pretty` to the
`Get-Content` command. If the service stops right after starting, check `ff-service.err.log` and
`ff-service.wrapper.log` in the same folder.

The service also appears in `services.msc`. `Stop-Service ff` sends Ctrl+C, so the server shuts down gracefully.

To check that it survives a reboot, run `Restart-Computer`, don't log in at the PC, and reload the page after 2–3
minutes. The service uses delayed auto-start, so it comes up about a minute after the other services.

### 7. Open it

- **By IP:** reserve an address for the PC in your router's DHCP settings (often called "DHCP reservation" or
  "static lease") so it doesn't change, then use `http://192.168.x.y:3000`. `ipconfig` shows the current address.
- **By name:** `http://ff-server.local:3000` works from Macs, iPhones and other Windows PCs. Some Android devices
  don't resolve `.local` names; use the IP there.

### 8. Updating

```powershell
powershell -ExecutionPolicy Bypass -File C:\ff\deploy\windows\update.ps1
```

[`update.ps1`](deploy/windows/update.ps1) runs `git pull --ff-only`, `npm ci` and `npm run build`, then restarts
the service. It stops at the first failure, so a broken build never replaces the running version.
`-ExecutionPolicy Bypass` lets this one script run without changing Windows' script policy.

- **After editing `.env`:** `Restart-Service ff`.
- **After editing `ff-service.xml`:** `C:\ff\deploy\windows\ff-service.exe refresh`, then `Restart-Service ff`.
- **To upgrade Node:** `winget upgrade --id OpenJS.NodeJS.LTS -e`, then run the update script.

### 9. Security

The dashboard has no login, and `.env` holds your ESPN cookies (the page never shows them, but the server acts on
them). Keep it on the home network:

- **Don't forward port 3000 on your router.** That would put it on the public internet.
- **The firewall rule only covers Private networks**, so if the PC ever joins a network marked Public, the port
  stays closed.
- **For access away from home, use [Tailscale](https://tailscale.com/):** a free private network between your
  own devices. Install it on the PC and your phone, and the phone can open the dashboard from anywhere via the
  PC's Tailscale name or address, while it stays invisible to everyone else.
- **Other accounts on this PC can read `C:\ff\.env`.** That's fine for a single-user home machine. If others use
  the PC, restrict the file with `icacls`.

### 10. Claude Code on the server (optional)

Claude Code runs on 64-bit Windows 10+ with 4 GB+ RAM, and uses the Git for Windows installed in step 4:

```powershell
irm https://claude.ai/install.ps1 | iex
# open a new PowerShell window, then:
cd C:\ff
claude
```

The first run asks you to log in through a browser. Over SSH, it prints a link you can open on another computer.

## Scripts

| Script              | What it does                                                    |
| ------------------- | --------------------------------------------------------------- |
| `npm run dev`       | Run from TypeScript source with auto-restart and pretty logs    |
| `npm test`          | Run tests (`src/**/*.test.ts`) with Node's built-in test runner |
| `npm run lint`      | ESLint, including type-aware TypeScript rules                   |
| `npm run format`    | Format everything with Prettier                                 |
| `npm run typecheck` | Type-check everything, including tests, without emitting        |
| `npm run check`     | Lint + format check + typecheck + tests (what CI runs)          |
| `npm run build`     | Compile to `dist/` (tests excluded)                             |
| `npm start`         | Run the compiled server                                         |

## How it's built

A Fastify server (`src/`) calls each platform's API, normalizes the result into one `Matchup` shape
(`src/types.ts`), and serves `GET /api/matchups`. A static page (`public/`) polls it. The server exists because ESPN
and Yahoo block browser calls and their credentials must stay out of the browser.

| Path                    | Role                                                                           |
| ----------------------- | ------------------------------------------------------------------------------ |
| `src/adapters/*.ts`     | One adapter per platform; each returns a `Matchup`                             |
| `src/sources.ts`        | Picks the configured leagues from `.env`                                       |
| `src/app.ts`            | The route: runs every league in parallel, 20s cache, errors become error cards |
| `src/nfl-scoreboard.ts` | Real NFL game states (not started / in progress / final) from ESPN             |
| `src/http.ts`           | Shared fetch-and-validate helper (timeouts, clear errors, zod checks)          |
| `deploy/windows/`       | Windows service config (WinSW) and update script for a home server             |
