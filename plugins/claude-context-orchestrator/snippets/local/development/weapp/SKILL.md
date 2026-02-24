---
name: "WeChat Mini Program Best Practices"
description: "Use when developing WeChat Mini Programs (小程序), working with Taro, or building cross-platform mini program apps. Covers architecture, constraints, performance, and common pitfalls."
---

# WeChat Mini Program (小程序) Best Practices

## Runtime Architecture

Two-thread model — logic (JSCore) and render (WebView) communicate via async serialized bridge:

```
Logic Thread (JS)  ←─ setData (JSON serialized) ─→  Render Thread (WXML/WXSS)
        ↑                  WeChat Native Bridge                 ↑
        └──────────────────────────────────────────────────────┘
```

- No DOM. No `window`, `document`, `fetch`, `localStorage`.
- All platform APIs go through `wx.*` (or `Taro.*` with framework).
- `setData` crosses the bridge — large/frequent calls = jank.

## Hard Constraints

| Constraint | Limit |
|-----------|-------|
| Subpackage size | 2MB each |
| Total package | 20MB |
| Page stack | 10 levels max |
| `setData` payload | Keep < 256KB |
| Network | HTTPS only, domains whitelisted in mp.weixin.qq.com |
| Review | Every version reviewed by WeChat (1-7 days) |
| Background | ~5s before suspension when user leaves |
| Dynamic code | No `eval()`, `new Function()`, dynamic `import()` |

## Performance Best Practices

### setData Optimization (Most Important)
```ts
// BAD — sends entire list across bridge every time
setData({ list: [...list, newItem] })

// GOOD — path-based partial update (native WXML)
setData({ [`list[${list.length}]`]: newItem })

// GOOD — in Taro/React, minimize state granularity
// Split large state objects into smaller pieces
const [header, setHeader] = useState(...)  // updated rarely
const [items, setItems] = useState(...)    // updated often
```

### Avoid
- Frequent `setData` in scroll handlers — debounce/throttle
- Storing non-rendered data in state — use refs or module variables
- Large images in package — use CDN URLs
- Deep component nesting — each level adds bridge overhead

### Image Handling
```ts
// Use lazy loading for lists
<Image lazyLoad src={url} mode="aspectFill" />

// Compress before upload, use WebP where supported
// Tab bar icons: must be local PNG, < 40KB each, 81x81px recommended
```

## Navigation Patterns

```
┌──────────────────────────┐
│ ← Back   Page Title    ⋯ │  ← Native nav bar (config-controlled)
├──────────────────────────┤
│                          │  ← Your content area
│                          │
├──────────────────────────┤
│ Tab1 │ Tab2 │ Tab3       │  ← Native TabBar (2-5 tabs, local PNGs)
└──────────────────────────┘
```

- `navigateTo` pushes onto stack (max 10). Use `redirectTo` to replace.
- `switchTab` for tab navigation — clears page stack above tab pages.
- `reLaunch` clears everything — use sparingly.
- The "..." menu in top-right is WeChat's. Cannot remove/modify.
- Custom nav bar: set `navigationStyle: 'custom'` — then YOU handle status bar safe area.

## Page Lifecycle (Taro/React)

```ts
import { useDidShow, useDidHide, usePullDownRefresh } from '@tarojs/taro'

function MyPage() {
  // useDidShow fires every time page becomes visible (including back navigation)
  useDidShow(() => { /* refresh data */ })

  // useDidHide fires when navigating away
  useDidHide(() => { /* cleanup */ })

  // Pull-to-refresh (must enable in page config: enablePullDownRefresh: true)
  usePullDownRefresh(() => {
    fetchData().finally(() => Taro.stopPullDownRefresh())
  })
}
```

## Network & Auth Pattern

```ts
// All requests go through Taro.request (NOT fetch)
// Domain must be whitelisted in WeChat admin console (except dev mode)

// Common auth pattern:
// 1. wx.login() → code
// 2. Send code to your server → server calls WeChat API → returns session + openid
// 3. Store token locally
Taro.setStorageSync('auth_token', token)

// 4. Inject in every request
Taro.addInterceptor((chain) => {
  const token = Taro.getStorageSync('auth_token')
  chain.requestParams.header = {
    ...chain.requestParams.header,
    'Authorization': `Bearer ${token}`
  }
  return chain.proceed(chain.requestParams)
})
```

## Storage

```ts
// Sync API (simpler, blocks thread — fine for small data)
Taro.setStorageSync('key', value)     // 10MB total limit
const val = Taro.getStorageSync('key')

// Async API (preferred for large data)
await Taro.setStorage({ key: 'key', data: value })
```

## Common Taro Gotchas

1. **CSS**: Use `page {}` not `:root` for CSS variables. No `*` selector. Use `rpx` (responsive px, 750rpx = screen width).

2. **Conditional rendering**: `{condition && <View>}` works, but avoid frequent show/hide of heavy components — use `display: none` style instead to keep the component alive.

3. **List rendering**: Always use `key` prop. For long lists, use `<VirtualList>` or paginate.

4. **Third-party packages**: Most npm packages that touch DOM won't work. Check compatibility first. Common safe ones: lodash, dayjs, axios (with Taro adapter).

5. **Subpackages**: Split non-tab pages into subpackages to keep main package < 2MB:
   ```ts
   // app.config.ts
   subPackages: [
     { root: 'pages/settings', pages: ['index', 'profile'] }
   ]
   ```

6. **Shared code across packages**: Use `mini.compile.include` in Taro config with path matcher function for packages outside the Taro app directory.

7. **Debug**: Use WeChat DevTools (微信开发者工具), not browser DevTools. The simulator is imperfect — always test on real device via "Preview" or "Real Device Debug".

## Platform Admin (mp.weixin.qq.com)

Must-configure before production:
- **服务器域名** (Server domains): whitelist all HTTPS API domains
- **业务域名** (Business domains): for web-view components
- **体验版** (Experience version): add test users as 体验者
- **版本管理** (Version management): submit → review (1-7 days) → release

## Package Size Strategy

```
Main package (< 2MB):
  ├── app.ts, app.config.ts
  ├── Tab pages only
  └── Shared components/utils

Subpackage A (< 2MB):
  └── Feature pages A

Subpackage B (< 2MB):
  └── Feature pages B

Independent subpackage (can preload):
  └── Heavy feature with its own deps
```

Use `preloadRule` in app.config to preload subpackages on WiFi when user is on a tab page.
