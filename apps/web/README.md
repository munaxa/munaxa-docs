# Munaxa Docs — web

The workspace. Next.js App Router, and the **only** browser-facing surface: the API is never
called from the browser.

## Where the tokens live

```text
browser ──form post──▶ server action ──HTTPS──▶ API
                            │                    returns { accessToken, refreshToken }
                            └── writes both into httpOnly cookies
```

The API sets no cookies and this application never puts a token in a response body, a prop or
a script tag. Neither token is reachable from client JavaScript, which is the property that
makes an injected `<script>` unable to steal a session
([17-security-architecture.md](../../docs/architecture/17-security-architecture.md) §2).

That is why sign-in is a **server action** rather than a `fetch` in a component: a client-side
sign-in has to receive the tokens in a response body first, which is the step this design
exists to remove.

| Cookie | Holds | Set by |
| --- | --- | --- |
| `edms_at` | Access token, ~15 minutes | `lib/auth.ts` |
| `edms_rt` | Refresh token, rotating | `lib/auth.ts` |
| `edms_locale` | Chosen language | Locale switcher |

All three are `httpOnly`, `Secure` outside development, and `SameSite=Lax` — `Lax` rather than
`Strict` so that following a link into the workspace from an email does not arrive signed out.

## Three layers of guard, and why each exists

1. **`middleware.ts`** — is there a session cookie at all? Cheap, runs at the edge, and cannot
   verify a signature. It stops the common case before a server render.
2. **`(workspace)/layout.tsx`** — asks the API who the caller is. A cookie is not a session: one
   that survived a revoked session, a rotated signing key or a disabled account fails here and
   lands on `/login`. This is also where navigation comes from, because permissions are the
   server's answer.
3. **The API** — decides everything that matters. The two layers above are courtesy; neither is
   a permission check.

Hiding a link is never a control. The endpoint behind it is guarded regardless
([08-permission-model.md](../../docs/architecture/08-permission-model.md) §7).

## The shell

Composed entirely from `@munaxa/ui` — `AppShell`, `Sidebar`, `SidebarNav`, `TopBar`,
`NavigationDrawer`, `UserMenu`, `useTheme`. Nothing here re-implements a shell, a menu or a
navigation list: the product's only visual difference from its siblings is the theme, and a
component written here would be a second answer to a question the platform already answers.

Responsiveness comes from the shell: a rail on wide viewports, a drawer on narrow ones, with a
content column that scrolls instead of the document.

**Navigation is data, resolved on the server** (`lib/navigation.ts`). A destination appears only
if the caller holds its permission *and* its screen exists. The table is short because Phase 1
built one screen; later phases add a row each as they build the destination it points at. A
menu item leading to a page that is not there is worse than an absent one — and with typed
routes on, it is now a build error rather than a 404 somebody finds later.

## Light and dark

`useTheme` from the platform, persisted under `edms.theme`. Its `scheme` is `null` until the
effect runs — the server render and the first paint — so the toggle must not assume either
value before then. Labelling it "Dark" on the server and flipping on hydration is both a
visible glitch and a hydration mismatch.

## Language

`lang` and `dir` are set from the session locale on the **server**, so an Arabic user never
sees a left-to-right frame repaint into a right-to-left one. Layout uses logical properties
only, which is what keeps that a one-attribute change rather than a second stylesheet.

Every user-visible string comes from `@edms/i18n`. A key missing from the Arabic catalogue is a
compile error, not a fallback to English.

## Still to build

Everything behind the shell. `features/` is empty by design — see
[`src/features/README.md`](./src/features/README.md) for the shape each one takes and which
phase brings it.
