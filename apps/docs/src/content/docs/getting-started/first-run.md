---
title: First run
description: Create the first administrator on the setup page.
---

A fresh install has no user. The API creates nothing by itself: the first
person to open the setup link becomes the administrator.

## The setup page

Open the setup link the install printed, for example
`http://localhost:8000/setup?token=…`, choose your name, email and password,
and you are signed in right after.

The link works once, and only while Nautelle has no user. Each start of the
API logs a new one and the older one stops working. To find the current link:

```sh
cd nautelle
docker compose logs api | grep -o 'http[^ ]*/setup?token=[^ ]*' | tail -n 1
```

## Without a browser

For an install nobody opens a browser on, pass the administrator to the
install instead:

```sh
curl -fsSL …/install.sh | sh -s -- --admin-email you@example.com --admin-password '…'
```

The API creates that account on its first start. `install.sh` hands the two
values to that start only and writes neither into `.env`.

## Next

- [Pair a runner](../pair-a-runner/): the machine where your agents work.
- [Connect a project](../connect-a-project/): a repository for the Board.
- Invite people: they register on the sign-in page, and an administrator
  approves each account under **Admin › Users**.

Why the first administrator is created this way:
[ADR-0087](https://github.com/AndreyBegma/Nautelle/blob/develop/docs/adr/0087-the-first-admin-is-created-in-the-browser-with-a-one-time-setup-token.md).
