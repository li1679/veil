## Design Context

### Users
- **Who**: Solo developer (project author), self-hosted open-source temporary email service
- **Context**: Personal tool for quick use — generating throwaway email addresses to grab verification codes, and programmatic access via API integration
- **Job to be done**: Get a working temp email address in < 3 seconds, see the verification code instantly, copy it, move on. Zero friction.

### Brand Personality
**Simple · Efficient · Clean**

- No marketing fluff, no decorative excess
- Tool-first: every pixel earns its place by serving a function
- Quiet confidence — the UI should feel like a well-made instrument, not a showpiece

### Aesthetic Direction
- **Visual tone**: iOS HIG — native Apple feel with frosted glass, precise spacing, systematic color
- **Theme**: Light + Dark (system-following, manual toggle)
- **Primary color**: iOS Blue `#007AFF` (light) / `#0A84FF` (dark) — the single accent color
- **Favicon gradient**: `#6366f1 → #22d3ee` (indigo→cyan) — kept as brand mark only, not propagated into UI chrome
- **Anti-references**:
  - NO "AI purple" (gradient purple/violet aesthetics associated with generic AI products)
  - NO gratuitous gradients, glow effects, or visual noise in the app UI
  - NO heavy illustration or mascot-driven design
- **Typography**: System font stack (`-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Inter"`)
- **Icons**: Phosphor Icons (regular + bold weights)
- **Border radius scale**: 8px (sm) → 12px (md) → 16px (card) → 20px (window)
- **Shadow scale**: 4 tiers — sm / card / float / knob
- **Motion**: Purposeful transitions only. Aurora background on login is acceptable as the single immersive moment; app pages stay utilitarian.

### Design Principles

1. **Function over decoration** — If a visual element doesn't help the user complete a task faster, remove it. Three clean lines beat one clever abstraction.

2. **Instant feedback** — Every action (copy, generate, delete, refresh) must have immediate, visible confirmation. Toast notifications, state transitions, loading states — all < 200ms perceived.

3. **Information density over whitespace** — This is a power-user tool. Favor compact layouts that show more data per screen. Don't waste vertical space on hero sections or excessive padding.

4. **System-native feel** — Match iOS/macOS platform conventions: SF Pro typography, system color semantics, HIG spacing (8pt grid), native-feeling controls (segmented controls, switches, sheets).

5. **Zero-config defaults** — The app should work perfectly with zero customization. Smart defaults for domain, expiry, prefix mode. One click to generate, one click to copy.

### Design Tokens (from codebase)

```
Colors (Light):
  --ios-bg: #F2F2F7
  --ios-card: #FFFFFF
  --accent-blue: #007AFF
  --system-red: #FF3B30
  --system-green: #34C759
  --label-primary: #111114
  --label-secondary: #3C3C4399
  --label-tertiary: #3C3C434D

Colors (Dark):
  --ios-bg: #000000
  --ios-card: #1C1C1E
  --accent-blue: #0A84FF
  --system-red: #FF453A
  --system-green: #32D74B
  --label-primary: #F5F5F7
  --label-secondary: #EBEBF599

Spacing: 8pt grid (4, 6, 8, 10, 12, 16, 20, 24, 28, 40px)
Easing: --ease-out (0.25, 1, 0.5, 1) | --ease-spring (0.19, 1, 0.22, 1)
```

### Tech Constraints
- Zero npm dependencies — all code is vanilla JS on Cloudflare Workers
- No build step — CSS/JS served directly from `public/`
- Tailwind CSS via CDN on login.html only (candidate for removal)
- No framework — MPA with ES Modules, global state in page-level JS files
- Accessibility features should be minimal — no WCAG compliance target, no screen reader optimization, no `prefers-reduced-motion` handling needed
