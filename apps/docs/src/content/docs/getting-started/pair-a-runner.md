---
title: Pair a runner
description: Install the runner on the machine with your repositories and pair it with the server.
---

The runner works on the machine that holds your repositories, which can be the
server itself or another machine. It connects out to the server over a
WebSocket, so the runner machine needs no open port.

## 1. Create a pairing code

In Nautelle, open **Admin › Runners** and choose **Add runner**. The dialog
shows a code like `ABCD-EF23`. It is valid for 10 minutes and works once.

## 2. Install and pair

On the runner machine:

```sh
brew install andreybegma/tap/nautelle-runner      # or: npm i -g nautelle-runner
nautelle-runner pair --server <NAUTELLE_URL>/api --code XXXX-XXXX --allow-root ~/dev
```

- `--server` is `NAUTELLE_URL` followed by `/api`, for example
  `https://dock.example.com/api` or `http://localhost:8000/api`.
- `--allow-root` names the folders the runner may work in, usually the folder
  that holds your clones. Repeat it for more than one. A runner works in no
  folder you have not allowed, and the server cannot change that list (see
  [Runner security](../../concepts/runner-security/)).

A runner refuses plain HTTP to any host but localhost, because the pairing
token would travel in clear text. Use a tunnel or a domain with HTTPS; on a
trusted network only, `pair --insecure` accepts an `http://` server.

## 3. Keep it online

```sh
nautelle-runner install-service       # with Homebrew: brew services start nautelle-runner
```

`install-service` writes a systemd user unit on Linux or a launchd agent on
macOS and prints the command that starts it. The runner then appears online
under **Admin › Runners**.

## Check it

```sh
nautelle-runner status
```

shows the configuration, the event spool and whether the server answers. To
allow another folder later:

```sh
nautelle-runner policy allow-root ~/work
```

Its configuration and token live in `~/.config/nautelle/runner.json`
(mode 600). To retire a runner, revoke it under **Admin › Runners**: its token
stops working at once.

Next: [connect a project](../connect-a-project/).
