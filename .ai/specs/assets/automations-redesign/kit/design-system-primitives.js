/* @ds-bundle: {"format":4,"namespace":"CezarDesignSystem_3b4141","components":[{"name":"Badge","sourcePath":"components/core/Badge.jsx"},{"name":"BranchChip","sourcePath":"components/core/BranchChip.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Card","sourcePath":"components/core/Card.jsx"},{"name":"CardHeader","sourcePath":"components/core/Card.jsx"},{"name":"CardTitle","sourcePath":"components/core/Card.jsx"},{"name":"CardDescription","sourcePath":"components/core/Card.jsx"},{"name":"CardContent","sourcePath":"components/core/Card.jsx"},{"name":"CardFooter","sourcePath":"components/core/Card.jsx"},{"name":"Chip","sourcePath":"components/core/Chip.jsx"},{"name":"DiffStat","sourcePath":"components/core/DiffStat.jsx"},{"name":"Icon","sourcePath":"components/core/Icon.jsx"},{"name":"Kbd","sourcePath":"components/core/Kbd.jsx"},{"name":"Pill","sourcePath":"components/core/Pill.jsx"},{"name":"Separator","sourcePath":"components/core/Separator.jsx"},{"name":"Skeleton","sourcePath":"components/core/Skeleton.jsx"},{"name":"StatusDot","sourcePath":"components/core/StatusDot.jsx"},{"name":"Input","sourcePath":"components/forms/Input.jsx"},{"name":"Label","sourcePath":"components/forms/Label.jsx"},{"name":"Segmented","sourcePath":"components/forms/Segmented.jsx"},{"name":"Select","sourcePath":"components/forms/Select.jsx"},{"name":"Switch","sourcePath":"components/forms/Switch.jsx"},{"name":"TabLink","sourcePath":"components/forms/TabLink.jsx"},{"name":"TabBar","sourcePath":"components/forms/TabLink.jsx"},{"name":"Textarea","sourcePath":"components/forms/Textarea.jsx"},{"name":"BrandLockup","sourcePath":"components/navigation/BrandLockup.jsx"},{"name":"NavItem","sourcePath":"components/navigation/NavItem.jsx"},{"name":"NavHeading","sourcePath":"components/navigation/NavItem.jsx"},{"name":"TaskRow","sourcePath":"components/navigation/TaskRow.jsx"},{"name":"CommandPalette","sourcePath":"components/overlays/CommandPalette.jsx"},{"name":"Dialog","sourcePath":"components/overlays/Dialog.jsx"},{"name":"AlertDialog","sourcePath":"components/overlays/Dialog.jsx"},{"name":"DropdownMenu","sourcePath":"components/overlays/DropdownMenu.jsx"},{"name":"Popover","sourcePath":"components/overlays/DropdownMenu.jsx"},{"name":"Sheet","sourcePath":"components/overlays/Sheet.jsx"},{"name":"Toast","sourcePath":"components/overlays/Toast.jsx"},{"name":"Toaster","sourcePath":"components/overlays/Toast.jsx"},{"name":"Tooltip","sourcePath":"components/overlays/Tooltip.jsx"},{"name":"TwinkleBackdrop","sourcePath":"components/thread/CenteredState.jsx"},{"name":"CenteredState","sourcePath":"components/thread/CenteredState.jsx"},{"name":"Collapsible","sourcePath":"components/thread/Collapsible.jsx"},{"name":"Reasoning","sourcePath":"components/thread/Reasoning.jsx"},{"name":"WorkingIndicator","sourcePath":"components/thread/Reasoning.jsx"},{"name":"ToolCard","sourcePath":"components/thread/ToolCard.jsx"},{"name":"UserBubble","sourcePath":"components/thread/UserBubble.jsx"},{"name":"AssistantMessage","sourcePath":"components/thread/UserBubble.jsx"},{"name":"NoteLine","sourcePath":"components/thread/UserBubble.jsx"}],"sourceHashes":{"components/core/Badge.jsx":"c03b2e6cce18","components/core/BranchChip.jsx":"80670a9f6e24","components/core/Button.jsx":"a7b89513e1eb","components/core/Card.jsx":"79a709952032","components/core/Chip.jsx":"6a49ed8713c1","components/core/DiffStat.jsx":"0dc912bfe752","components/core/Icon.jsx":"daade8b88d52","components/core/Kbd.jsx":"01165c819f68","components/core/Pill.jsx":"8129231dcdfe","components/core/Separator.jsx":"ee2697c58c65","components/core/Skeleton.jsx":"10a5d604ece3","components/core/StatusDot.jsx":"db38f9fea540","components/core/cz.js":"13af33fcbdc6","components/forms/Input.jsx":"353a65bdde28","components/forms/Label.jsx":"2d26ec796d66","components/forms/Segmented.jsx":"3db2ded74c86","components/forms/Select.jsx":"85f71bfd655e","components/forms/Switch.jsx":"6c0d81dd8279","components/forms/TabLink.jsx":"3a3c489e4596","components/forms/Textarea.jsx":"45ac366875a1","components/navigation/BrandLockup.jsx":"415b8c830025","components/navigation/NavItem.jsx":"cd903beb169b","components/navigation/TaskRow.jsx":"de89b4ec55c1","components/overlays/CommandPalette.jsx":"7a4066a01ec3","components/overlays/Dialog.jsx":"dd6971205055","components/overlays/DropdownMenu.jsx":"7bbcd3df24d8","components/overlays/Sheet.jsx":"4548b8c64a77","components/overlays/Toast.jsx":"4d849e40aacc","components/overlays/Tooltip.jsx":"c44392cce1d6","components/thread/CenteredState.jsx":"6c261cdb3c23","components/thread/Collapsible.jsx":"bb4e267796ee","components/thread/Reasoning.jsx":"caeafc6e5eff","components/thread/ToolCard.jsx":"9aab0155b36b","components/thread/UserBubble.jsx":"b5be20afb2f2","ui_kits/cockpit/AutomationsScreen.jsx":"8c66533e5351","ui_kits/cockpit/NewTaskScreen.jsx":"15059dc96c7f","ui_kits/cockpit/SettingsScreen.jsx":"bf5e9c616d4d","ui_kits/cockpit/Shell.jsx":"c18763c5bbd4","ui_kits/cockpit/TasksScreen.jsx":"8401d5e34927","ui_kits/cockpit/ThreadScreen.jsx":"6670a5cf9730","ui_kits/cockpit/data.js":"b8ae77905617"},"inlinedExternals":[],"unexposedExports":[{"name":"css","sourcePath":"components/core/cz.js"},{"name":"cx","sourcePath":"components/core/cz.js"}]} */

(() => {

const __ds_ns = (window.CezarDesignSystem_3b4141 = window.CezarDesignSystem_3b4141 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/core/BranchChip.jsx
try { (() => {
function BranchChip({
  children,
  style
}) {
  return React.createElement('span', {
    'data-slot': 'branch-chip',
    style: {
      display: 'inline-block',
      borderRadius: 6,
      background: 'var(--muted)',
      padding: '2px 6px',
      font: '500 11.5px/1.3 var(--mono)',
      color: 'var(--muted-foreground)',
      whiteSpace: 'nowrap',
      ...style
    }
  }, children);
}
Object.assign(__ds_scope, { BranchChip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/BranchChip.jsx", error: String((e && e.message) || e) }); }

// components/core/DiffStat.jsx
try { (() => {
function DiffStat({
  adds = 0,
  dels = 0,
  files,
  className,
  style
}) {
  const title = files !== undefined ? `+${adds} −${dels} across ${files} ${files === 1 ? 'file' : 'files'}` : undefined;
  return React.createElement('span', {
    'data-slot': 'diff-stat',
    title,
    className,
    style: {
      fontFamily: 'var(--mono)',
      fontSize: 12,
      fontWeight: 600,
      fontVariantNumeric: 'tabular-nums',
      ...style
    }
  }, React.createElement('span', {
    style: {
      color: 'var(--success)'
    }
  }, '+', adds), ' ', React.createElement('span', {
    style: {
      color: 'var(--danger)'
    }
  }, '−', dels));
}
Object.assign(__ds_scope, { DiffStat });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/DiffStat.jsx", error: String((e && e.message) || e) }); }

// components/core/Icon.jsx
try { (() => {
/** Lucide glyph by name. Needs the lucide UMD bundle on the page: <script src="https://unpkg.com/lucide@0.460.0/dist/umd/lucide.min.js"></script> */
function Icon({
  name,
  size = 16,
  strokeWidth = 2,
  className,
  style,
  ...rest
}) {
  const lib = typeof window !== 'undefined' && window.lucide && window.lucide.icons;
  const pascal = name.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase());
  const raw = lib ? lib[pascal] || lib[name] : null;
  const node = Array.isArray(raw) && raw[0] === 'svg' ? raw[2] : raw;
  const kids = Array.isArray(node) ? node.map(([tag, attrs], i) => React.createElement(tag, {
    key: i,
    ...attrs
  })) : null;
  return React.createElement('svg', {
    xmlns: 'http://www.w3.org/2000/svg',
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    'data-icon': name,
    className,
    style: {
      flexShrink: 0,
      ...style
    },
    ...rest
  }, kids);
}
Object.assign(__ds_scope, { Icon });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Icon.jsx", error: String((e && e.message) || e) }); }

// components/core/Kbd.jsx
try { (() => {
function Kbd({
  children,
  onContrast = false,
  style
}) {
  return React.createElement('kbd', {
    'aria-hidden': 'true',
    style: {
      display: 'inline-block',
      borderRadius: 5,
      border: '1px solid ' + (onContrast ? 'color-mix(in srgb,var(--contrast-foreground) 25%,transparent)' : 'var(--border)'),
      borderBottomWidth: 2,
      background: onContrast ? 'transparent' : 'var(--card)',
      padding: '1px 5px',
      font: '500 10.5px/1.3 var(--mono)',
      color: onContrast ? 'color-mix(in srgb,var(--contrast-foreground) 60%,transparent)' : 'var(--muted-foreground)',
      ...style
    }
  }, children);
}
Object.assign(__ds_scope, { Kbd });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Kbd.jsx", error: String((e && e.message) || e) }); }

// components/core/Separator.jsx
try { (() => {
function Separator({
  orientation = 'horizontal',
  style
}) {
  const v = orientation === 'vertical';
  return React.createElement('div', {
    role: 'separator',
    'aria-orientation': orientation,
    style: {
      flexShrink: 0,
      background: 'var(--border)',
      width: v ? 1 : '100%',
      height: v ? '100%' : 1,
      ...style
    }
  });
}
Object.assign(__ds_scope, { Separator });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Separator.jsx", error: String((e && e.message) || e) }); }

// components/core/Skeleton.jsx
try { (() => {
function Skeleton({
  width = '100%',
  height = 14,
  radius = 'var(--radius)',
  style
}) {
  return React.createElement('div', {
    'data-slot': 'skeleton',
    style: {
      width,
      height,
      borderRadius: radius,
      background: 'var(--accent)',
      animation: 'cez-pulse 2s cubic-bezier(.4,0,.6,1) infinite',
      ...style
    }
  });
}
Object.assign(__ds_scope, { Skeleton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Skeleton.jsx", error: String((e && e.message) || e) }); }

// components/core/cz.js
try { (() => {
// shared helpers for cezar DS components — not a component (lowercase)
const injected = new Set();
function css(id, text) {
  if (typeof document === 'undefined' || injected.has(id)) return;
  injected.add(id);
  const s = document.createElement('style');
  s.setAttribute('data-cz', id);
  s.textContent = text;
  document.head.appendChild(s);
}
function cx(...a) {
  return a.filter(Boolean).join(' ');
}
Object.assign(__ds_scope, { css, cx });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/cz.js", error: String((e && e.message) || e) }); }

// components/core/Badge.jsx
try { (() => {
__ds_scope.css('badge', `
.cz-badge{display:inline-flex;width:fit-content;flex-shrink:0;align-items:center;justify-content:center;gap:4px;overflow:hidden;border-radius:999px;border:1px solid transparent;padding:2px 8px;font:500 12px/1.33 var(--sans);white-space:nowrap}
.cz-badge[data-variant=default]{background:var(--primary);color:var(--primary-foreground)}
.cz-badge[data-variant=secondary]{background:var(--secondary);color:var(--secondary-foreground)}
.cz-badge[data-variant=destructive]{background:var(--destructive);color:var(--destructive-foreground)}
.cz-badge[data-variant=outline]{border-color:var(--border);color:var(--foreground)}
.cz-badge[data-variant=ghost]{color:var(--foreground)}
.cz-badge[data-variant=violet]{background:var(--violet);color:var(--violet-foreground);padding:1px 6px;font-size:10.5px;font-weight:600}
.cz-badge[data-variant=count]{background:var(--muted);color:var(--muted-foreground);padding:1px 6px;font-size:10.5px}
`);
function Badge({
  variant = 'default',
  className,
  children,
  ...rest
}) {
  return React.createElement('span', {
    'data-slot': 'badge',
    'data-variant': variant,
    className: __ds_scope.cx('cz-badge', className),
    ...rest
  }, children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Badge.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
__ds_scope.css('btn', `
.cz-btn{display:inline-flex;flex-shrink:0;align-items:center;justify-content:center;gap:7px;border:0;border-radius:var(--radius);font:600 13.5px/1 var(--sans);white-space:nowrap;cursor:pointer;height:36px;padding:0 14px;background:transparent;color:inherit;transition:background-color .15s,border-color .15s,opacity .15s,filter .15s;outline:none}
.cz-btn:focus-visible{box-shadow:var(--focus-ring)}
.cz-btn:disabled{pointer-events:none;opacity:.5}
.cz-btn[data-variant=primary]{background:var(--primary);color:var(--primary-foreground)}
.cz-btn[data-variant=primary]:hover{filter:brightness(.96)}
.cz-btn[data-variant=contrast]{background:var(--contrast);color:var(--contrast-foreground)}
.cz-btn[data-variant=contrast]:hover{filter:brightness(.96)}
.cz-btn[data-variant=outline]{border:1px solid var(--border);background:var(--card)}
.cz-btn[data-variant=outline]:hover{background:var(--muted)}
.cz-btn[data-variant=ghost]{color:var(--muted-foreground)}
.cz-btn[data-variant=ghost]:hover{background:var(--muted);color:var(--foreground)}
.cz-btn[data-variant=danger-ghost]{color:var(--danger)}
.cz-btn[data-variant=danger-ghost]:hover{background:color-mix(in srgb,var(--danger) 10%,transparent)}
.cz-btn[data-size=sm]{height:30px;padding:0 10px;font-size:12.5px;border-radius:var(--radius-sm)}
.cz-btn[data-size=icon]{width:36px;padding:0}
.cz-btn[data-size=icon-sm]{width:30px;height:30px;padding:0;border-radius:var(--radius-sm)}
`);
function Button({
  variant = 'primary',
  size = 'default',
  className,
  children,
  as = 'button',
  ...rest
}) {
  return React.createElement(as, {
    'data-slot': 'button',
    'data-variant': variant,
    'data-size': size,
    className: __ds_scope.cx('cz-btn', className),
    type: as === 'button' ? rest.type || 'button' : undefined,
    ...rest
  }, children);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/Card.jsx
try { (() => {
__ds_scope.css('card', `.cz-card{display:flex;flex-direction:column;gap:24px;border-radius:var(--radius-lg);border:1px solid var(--border);background:var(--card);padding:24px 0;color:var(--card-foreground);box-shadow:var(--shadow-xs)}
.cz-card[data-flush=true]{padding:0;gap:0;overflow:hidden}
.cz-card[data-grad=true]{border-top:0}.cz-card[data-grad=true]::before{content:'';display:block;height:3px;background:var(--grad)}
.cz-card-h{display:grid;gap:8px;padding:0 24px}.cz-card-t{font:600 14px/1 var(--sans)}.cz-card-d{font:400 14px/1.4 var(--sans);color:var(--muted-foreground)}.cz-card-c{padding:0 24px}.cz-card-f{display:flex;align-items:center;padding:0 24px}`);
function Card({
  flush = false,
  gradientEdge = false,
  className,
  children,
  ...rest
}) {
  return React.createElement('div', {
    'data-slot': 'card',
    'data-flush': flush ? 'true' : undefined,
    'data-grad': gradientEdge ? 'true' : undefined,
    className: __ds_scope.cx('cz-card', className),
    ...rest
  }, children);
}
function CardHeader(p) {
  return React.createElement('div', {
    className: 'cz-card-h',
    ...p
  });
}
function CardTitle(p) {
  return React.createElement('div', {
    className: 'cz-card-t',
    ...p
  });
}
function CardDescription(p) {
  return React.createElement('div', {
    className: 'cz-card-d',
    ...p
  });
}
function CardContent(p) {
  return React.createElement('div', {
    className: 'cz-card-c',
    ...p
  });
}
function CardFooter(p) {
  return React.createElement('div', {
    className: 'cz-card-f',
    ...p
  });
}
Object.assign(__ds_scope, { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Card.jsx", error: String((e && e.message) || e) }); }

// components/core/Chip.jsx
try { (() => {
__ds_scope.css('chip', `.cz-chip{display:inline-flex;height:26px;align-items:center;gap:6px;border-radius:999px;border:1px solid var(--border);background:var(--card);padding:0 10px;font:500 12px/1 var(--sans);color:var(--muted-foreground);cursor:pointer;transition:background-color .15s,color .15s;white-space:nowrap}
.cz-chip:hover{background:var(--muted);color:var(--foreground)}
.cz-chip:disabled{pointer-events:none;opacity:.55}
.cz-chip[data-active=true]{border-color:var(--foreground);color:var(--foreground);font-weight:600}
.cz-chip[data-skill=true]{border-color:var(--violet);color:var(--foreground);font-family:var(--mono);font-weight:600}
.cz-chip .cz-chip-chev{color:var(--soft-foreground)}`);
function Chip({
  active = false,
  skill = false,
  chevron = false,
  icon,
  className,
  children,
  ...rest
}) {
  return React.createElement('button', {
    type: 'button',
    'data-slot': 'chip',
    'data-active': active ? 'true' : undefined,
    'data-skill': skill ? 'true' : undefined,
    className: __ds_scope.cx('cz-chip', className),
    ...rest
  }, icon ? React.createElement(__ds_scope.Icon, {
    name: icon,
    size: 12
  }) : null, children, chevron ? React.createElement(__ds_scope.Icon, {
    name: 'chevron-down',
    size: 10,
    className: 'cz-chip-chev'
  }) : null);
}
Object.assign(__ds_scope, { Chip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Chip.jsx", error: String((e && e.message) || e) }); }

// components/core/StatusDot.jsx
try { (() => {
__ds_scope.css('dot', `.cz-dot{display:inline-block;width:7px;height:7px;flex-shrink:0;border-radius:999px;background:var(--soft-foreground)}
.cz-dot[data-tone=success]{background:var(--success)}.cz-dot[data-tone=pending]{background:var(--pending)}.cz-dot[data-tone=danger]{background:var(--danger)}.cz-dot[data-tone=violet]{background:var(--violet)}
.cz-dot[data-pulse=true]{animation:cez-pulse 1.6s ease-in-out infinite}`);
function StatusDot({
  tone = 'neutral',
  pulse = false,
  className,
  ...rest
}) {
  return React.createElement('span', {
    'data-slot': 'status-dot',
    'data-tone': tone,
    'data-pulse': pulse ? 'true' : undefined,
    className: __ds_scope.cx('cz-dot', className),
    ...rest
  });
}
Object.assign(__ds_scope, { StatusDot });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/StatusDot.jsx", error: String((e && e.message) || e) }); }

// components/core/Pill.jsx
try { (() => {
__ds_scope.css('pill', `.cz-pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;background:var(--muted);padding:3px 10px;font:500 12px/1.33 var(--sans);white-space:nowrap;color:var(--muted-foreground)}`);
function Pill({
  dot,
  pulse = false,
  className,
  children,
  ...rest
}) {
  return React.createElement('span', {
    'data-slot': 'pill',
    className: __ds_scope.cx('cz-pill', className),
    ...rest
  }, dot ? React.createElement(__ds_scope.StatusDot, {
    tone: dot,
    pulse
  }) : null, children);
}
Object.assign(__ds_scope, { Pill });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Pill.jsx", error: String((e && e.message) || e) }); }

// components/forms/Input.jsx
try { (() => {
__ds_scope.css('input', `.cz-input{height:36px;width:100%;min-width:0;border-radius:var(--radius);border:1px solid var(--input);background:var(--card);padding:4px 12px;font:400 14px/1.4 var(--sans);color:var(--foreground);box-shadow:var(--shadow-xs);outline:none;transition:color .15s,box-shadow .15s}
.cz-input::placeholder{color:var(--soft-foreground)}.cz-input:focus-visible{border-color:var(--ring);box-shadow:var(--focus-ring)}.cz-input:disabled{pointer-events:none;cursor:not-allowed;opacity:.5}
.cz-input[aria-invalid=true]{border-color:var(--destructive);box-shadow:0 0 0 3px color-mix(in srgb,var(--destructive) 20%,transparent)}
.cz-input-wrap{position:relative;display:flex;align-items:center}.cz-input-wrap[data-icon=true] .cz-input{padding-left:32px;font-size:13px}.cz-input-wrap>svg{position:absolute;left:10px;color:var(--soft-foreground);pointer-events:none}`);
function Input({
  icon,
  className,
  style,
  ...rest
}) {
  const input = React.createElement('input', {
    'data-slot': 'input',
    className: __ds_scope.cx('cz-input', className),
    ...rest
  });
  if (!icon) return React.cloneElement(input, {
    style
  });
  return React.createElement('div', {
    className: 'cz-input-wrap',
    'data-icon': 'true',
    style
  }, React.createElement(__ds_scope.Icon, {
    name: icon,
    size: 14
  }), input);
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Input.jsx", error: String((e && e.message) || e) }); }

// components/forms/Label.jsx
try { (() => {
function Label({
  children,
  hint,
  style,
  ...rest
}) {
  return React.createElement('label', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      font: '500 14px/1 var(--sans)',
      userSelect: 'none',
      ...style
    },
    ...rest
  }, children, hint ? React.createElement('span', {
    style: {
      font: '400 12px/1 var(--sans)',
      color: 'var(--muted-foreground)'
    }
  }, hint) : null);
}
Object.assign(__ds_scope, { Label });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Label.jsx", error: String((e && e.message) || e) }); }

// components/forms/Segmented.jsx
try { (() => {
__ds_scope.css('seg', `.cz-seg{display:inline-flex;gap:2px;border-radius:var(--radius);background:var(--muted);padding:3px}.cz-seg[data-full=true]{width:100%}.cz-seg[data-full=true]>button{flex:1}
.cz-seg>button{display:flex;height:28px;align-items:center;justify-content:center;gap:6px;border:0;border-radius:7px;padding:0 12px;font:500 12.5px/1 var(--sans);color:var(--muted-foreground);background:transparent;cursor:pointer;white-space:nowrap;transition:color .15s}
.cz-seg>button:hover{color:var(--foreground)}.cz-seg>button[aria-pressed=true]{background:var(--card);color:var(--foreground);font-weight:600;box-shadow:var(--shadow-xs)}
.cz-seg>button small{font:400 11px/1 var(--mono);font-variant-numeric:tabular-nums}`);
function Segmented({
  options = [],
  value,
  defaultValue,
  onValueChange,
  full = false,
  className,
  style
}) {
  const [inner, setInner] = React.useState(defaultValue ?? (options[0] && options[0].value));
  const val = value !== undefined ? value : inner;
  return React.createElement('div', {
    'data-slot': 'segmented',
    'data-full': full ? 'true' : undefined,
    className: __ds_scope.cx('cz-seg', className),
    style
  }, options.map(o => React.createElement('button', {
    key: o.value,
    type: 'button',
    'aria-pressed': o.value === val,
    onClick: () => {
      if (value === undefined) setInner(o.value);
      onValueChange && onValueChange(o.value);
    }
  }, o.label, o.count ? React.createElement('small', null, o.count) : null)));
}
Object.assign(__ds_scope, { Segmented });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Segmented.jsx", error: String((e && e.message) || e) }); }

// components/forms/Select.jsx
try { (() => {
__ds_scope.css('select', `.cz-select{position:relative;display:inline-flex;width:fit-content}.cz-select-trig{display:flex;width:100%;align-items:center;justify-content:space-between;gap:8px;border-radius:var(--radius);border:1px solid var(--input);background:var(--card);padding:0 12px;height:36px;font:400 14px/1 var(--sans);color:var(--foreground);box-shadow:var(--shadow-xs);cursor:pointer;outline:none;white-space:nowrap}
.cz-select-trig[data-size=sm]{height:32px}.cz-select-trig:hover{background:var(--muted)}.cz-select-trig:focus-visible{border-color:var(--ring);box-shadow:var(--focus-ring)}.cz-select-trig:disabled{cursor:not-allowed;opacity:.5}.cz-select-trig[data-placeholder=true]{color:var(--muted-foreground)}.cz-select-trig>svg{opacity:.5;color:var(--muted-foreground)}
.cz-select-menu{position:absolute;top:calc(100% + 4px);left:0;z-index:50;min-width:100%;max-height:300px;overflow:auto;border-radius:var(--radius);border:1px solid var(--border);background:var(--popover);color:var(--popover-foreground);box-shadow:var(--shadow-md);padding:4px}
.cz-select-item{position:relative;display:flex;width:100%;align-items:center;gap:8px;border-radius:var(--radius-sm);padding:6px 32px 6px 8px;font:400 14px/1.4 var(--sans);cursor:default;user-select:none;border:0;background:none;color:inherit;text-align:left}.cz-select-item:hover,.cz-select-item:focus{background:var(--accent);outline:none}.cz-select-item[data-disabled=true]{pointer-events:none;opacity:.5}.cz-select-item>svg{position:absolute;right:8px}
.cz-select-label{padding:6px 8px;font:400 12px var(--sans);color:var(--muted-foreground)}`);
function Select({
  options = [],
  value,
  defaultValue,
  onValueChange,
  placeholder = 'Select…',
  size = 'default',
  disabled,
  style,
  className
}) {
  const [inner, setInner] = React.useState(defaultValue);
  const [open, setOpen] = React.useState(false);
  const val = value !== undefined ? value : inner;
  const cur = options.find(o => o.value === val);
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!open) return;
    const h = e => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return React.createElement('div', {
    className: __ds_scope.cx('cz-select', className),
    style,
    ref
  }, React.createElement('button', {
    type: 'button',
    'data-slot': 'select-trigger',
    'data-size': size,
    'data-placeholder': cur ? undefined : 'true',
    className: 'cz-select-trig',
    disabled,
    'aria-expanded': open,
    onClick: () => setOpen(o => !o)
  }, cur ? cur.label : placeholder, React.createElement(__ds_scope.Icon, {
    name: 'chevron-down',
    size: 16
  })), open ? React.createElement('div', {
    role: 'listbox',
    className: 'cz-select-menu'
  }, options.map(o => o.group ? React.createElement('div', {
    key: 'g' + o.group,
    className: 'cz-select-label'
  }, o.group) : React.createElement('button', {
    key: o.value,
    type: 'button',
    role: 'option',
    'aria-selected': o.value === val,
    'data-disabled': o.disabled ? 'true' : undefined,
    className: 'cz-select-item',
    onClick: () => {
      if (value === undefined) setInner(o.value);
      onValueChange && onValueChange(o.value);
      setOpen(false);
    }
  }, o.label, o.value === val ? React.createElement(__ds_scope.Icon, {
    name: 'check',
    size: 16
  }) : null))) : null);
}
Object.assign(__ds_scope, { Select });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Select.jsx", error: String((e && e.message) || e) }); }

// components/forms/Switch.jsx
try { (() => {
__ds_scope.css('switch', `.cz-switch{position:relative;display:inline-flex;flex-shrink:0;align-items:center;border-radius:999px;border:1px solid transparent;box-shadow:var(--shadow-xs);cursor:pointer;outline:none;background:var(--input);transition:background .15s;padding:0;height:18.4px;width:32px}
.cz-switch[data-size=sm]{height:14px;width:24px}.cz-switch[data-state=checked]{background:var(--primary)}.cz-switch:focus-visible{border-color:var(--ring);box-shadow:var(--focus-ring)}.cz-switch:disabled{cursor:not-allowed;opacity:.5}
.cz-switch i{display:block;border-radius:999px;background:var(--background);width:16px;height:16px;transition:transform .15s;transform:translateX(0)}.cz-switch[data-size=sm] i{width:12px;height:12px}
.cz-switch[data-state=checked] i{transform:translateX(calc(100% - 2px))}`);
function Switch({
  checked,
  defaultChecked = false,
  onCheckedChange,
  size = 'default',
  className,
  ...rest
}) {
  const [inner, setInner] = React.useState(defaultChecked);
  const on = checked !== undefined ? checked : inner;
  return React.createElement('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': on,
    'data-slot': 'switch',
    'data-size': size,
    'data-state': on ? 'checked' : 'unchecked',
    className: __ds_scope.cx('cz-switch', className),
    onClick: () => {
      const n = !on;
      if (checked === undefined) setInner(n);
      onCheckedChange && onCheckedChange(n);
    },
    ...rest
  }, React.createElement('i'));
}
Object.assign(__ds_scope, { Switch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Switch.jsx", error: String((e && e.message) || e) }); }

// components/forms/TabLink.jsx
try { (() => {
__ds_scope.css('tab', `.cz-tabs{display:flex;border-bottom:1px solid var(--border)}
.cz-tab{display:flex;height:32px;align-items:center;margin-bottom:-1px;border-radius:var(--radius) var(--radius) 0 0;border-bottom:2px solid transparent;padding:0 12px;font:500 13px/1 var(--sans);color:var(--muted-foreground);cursor:pointer;white-space:nowrap;background:none;border-top:0;border-left:0;border-right:0;transition:color .15s,background .15s}
.cz-tab:hover{background:var(--muted);color:var(--foreground)}.cz-tab[aria-current=page]{border-bottom-color:var(--foreground);color:var(--foreground);font-weight:600}`);
function TabLink({
  active = false,
  href,
  children,
  className,
  ...rest
}) {
  return React.createElement(href ? 'a' : 'button', {
    href,
    type: href ? undefined : 'button',
    'aria-current': active ? 'page' : undefined,
    className: __ds_scope.cx('cz-tab', className),
    ...rest
  }, children);
}
function TabBar({
  children,
  style,
  className
}) {
  return React.createElement('div', {
    role: 'tablist',
    className: __ds_scope.cx('cz-tabs', className),
    style
  }, children);
}
Object.assign(__ds_scope, { TabLink, TabBar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/TabLink.jsx", error: String((e && e.message) || e) }); }

// components/forms/Textarea.jsx
try { (() => {
__ds_scope.css('textarea', `.cz-textarea{display:block;min-height:64px;width:100%;resize:none;border-radius:var(--radius);border:1px solid var(--input);background:var(--card);padding:8px 12px;font:400 14px/1.5 var(--sans);color:var(--foreground);box-shadow:var(--shadow-xs);outline:none;field-sizing:content}
.cz-textarea::placeholder{color:var(--soft-foreground)}.cz-textarea:focus-visible{border-color:var(--ring);box-shadow:var(--focus-ring)}.cz-textarea:disabled{cursor:not-allowed;opacity:.5}
.cz-textarea[data-bare=true]{border:0;background:transparent;box-shadow:none;padding:0;font-size:15px;line-height:1.55}.cz-textarea[data-bare=true]:focus-visible{box-shadow:none}`);
function Textarea({
  bare = false,
  className,
  ...rest
}) {
  return React.createElement('textarea', {
    'data-slot': 'textarea',
    'data-bare': bare ? 'true' : undefined,
    className: __ds_scope.cx('cz-textarea', className),
    ...rest
  });
}
Object.assign(__ds_scope, { Textarea });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Textarea.jsx", error: String((e && e.message) || e) }); }

// components/navigation/BrandLockup.jsx
try { (() => {
function BrandLockup({
  repo,
  branch,
  logoSrc = '../../assets/logo.svg',
  style
}) {
  return React.createElement('div', {
    'data-slot': 'brand-lockup',
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 9,
      padding: '14px 14px 10px',
      ...style
    }
  }, React.createElement('img', {
    src: logoSrc,
    alt: '',
    'aria-hidden': 'true',
    style: {
      width: 26,
      height: 26,
      borderRadius: 8,
      flexShrink: 0
    }
  }), React.createElement('span', {
    style: {
      font: '600 15px/1 var(--sans)'
    }
  }, 'cezar'), repo ? React.createElement('span', {
    'data-slot': 'repo-chip',
    style: {
      marginLeft: 'auto',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      font: '500 11px/1 var(--mono)',
      color: 'var(--soft-foreground)'
    }
  }, repo, ' / ', branch) : null);
}
Object.assign(__ds_scope, { BrandLockup });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/BrandLockup.jsx", error: String((e && e.message) || e) }); }

// components/navigation/NavItem.jsx
try { (() => {
__ds_scope.css('nav', `.cz-nav{display:flex;height:34px;width:100%;align-items:center;gap:10px;border-radius:var(--radius-sm);padding:0 10px;font:500 13.5px/1 var(--sans);color:var(--muted-foreground);cursor:pointer;border:0;background:none;text-align:left;transition:background-color .15s,color .15s;box-sizing:border-box}
.cz-nav:hover{background:var(--muted);color:var(--foreground)}.cz-nav[aria-current=page]{background:var(--muted);color:var(--foreground);font-weight:600}.cz-nav>svg{flex-shrink:0}.cz-nav-b{margin-left:auto}
.cz-nav-dot{margin-left:auto;width:6px;height:6px;border-radius:999px;background:var(--violet)}
.cz-nav-h{padding:10px 12px 4px;font:600 11px/1 var(--sans);letter-spacing:.04em;text-transform:uppercase;color:var(--soft-foreground)}`);
function NavItem({
  icon,
  label,
  active = false,
  count,
  marker = false,
  href,
  className,
  ...rest
}) {
  return React.createElement(href ? 'a' : 'button', {
    href,
    type: href ? undefined : 'button',
    'aria-current': active ? 'page' : undefined,
    className: __ds_scope.cx('cz-nav', className),
    ...rest
  }, icon ? React.createElement(__ds_scope.Icon, {
    name: icon,
    size: 16
  }) : null, label, count ? React.createElement(__ds_scope.Badge, {
    variant: 'violet',
    className: 'cz-nav-b'
  }, count) : null, marker && !count ? React.createElement('span', {
    className: 'cz-nav-dot',
    'aria-label': 'update available'
  }) : null);
}
function NavHeading({
  children
}) {
  return React.createElement('h2', {
    className: 'cz-nav-h',
    style: {
      margin: 0
    }
  }, children);
}
Object.assign(__ds_scope, { NavItem, NavHeading });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/NavItem.jsx", error: String((e && e.message) || e) }); }

// components/navigation/TaskRow.jsx
try { (() => {
__ds_scope.css('taskrow', `.cz-trow{display:flex;align-items:center;gap:8px;border-radius:var(--radius-sm);padding-left:10px;cursor:pointer;color:var(--foreground)}.cz-trow:hover,.cz-trow[data-active=true]{background:var(--muted)}
.cz-trow-l{display:flex;min-width:0;flex:1;align-items:center;gap:8px;padding:7px 10px 7px 0}.cz-trow-t{min-width:7rem;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 13px/1.3 var(--sans)}.cz-trow-t[data-unread=true]{font-weight:600}.cz-trow-t[data-read=true]{color:var(--muted-foreground)}
.cz-trow-age{flex-shrink:0;font:400 11px/1 var(--sans);color:var(--soft-foreground);font-variant-numeric:tabular-nums}
.cz-trow-ref{display:inline-flex;align-items:center;gap:2px;border-radius:999px;border:1px solid color-mix(in srgb,var(--violet) 40%,transparent);color:var(--violet);padding:1px 6px;font:600 10.5px/1.3 var(--mono)}
.cz-trow-var{display:inline-flex;width:15px;height:15px;align-items:center;justify-content:center;border-radius:999px;background:color-mix(in srgb,var(--violet) 15%,transparent);font:600 9.5px/1 var(--mono);color:var(--violet)}`);
function TaskRow({
  tone = 'neutral',
  pulse = false,
  title,
  age,
  adds,
  dels,
  reference,
  unread = false,
  read = false,
  active = false,
  variant,
  depth = 0,
  subtasks,
  kind,
  className,
  ...rest
}) {
  return React.createElement('div', {
    'data-slot': 'task-row',
    'data-active': active ? 'true' : undefined,
    className: __ds_scope.cx('cz-trow', className),
    style: depth ? {
      paddingLeft: 10 + depth * 14
    } : variant ? {
      paddingLeft: 26
    } : undefined,
    ...rest
  }, React.createElement(__ds_scope.StatusDot, {
    tone,
    pulse
  }), reference ? React.createElement('span', {
    className: 'cz-trow-ref'
  }, reference, React.createElement(__ds_scope.Icon, {
    name: 'arrow-up-right',
    size: 9
  })) : null, React.createElement('span', {
    className: 'cz-trow-l'
  }, variant ? React.createElement('span', {
    className: 'cz-trow-var'
  }, variant) : null, React.createElement('span', {
    className: 'cz-trow-t',
    'data-unread': unread ? 'true' : undefined,
    'data-read': read ? 'true' : undefined,
    title
  }, title), kind ? React.createElement(__ds_scope.Badge, {
    variant: 'count',
    style: {
      fontSize: 10
    }
  }, kind) : null, adds !== undefined ? React.createElement(__ds_scope.DiffStat, {
    adds,
    dels,
    style: {
      fontSize: 10.5
    }
  }) : null, subtasks ? React.createElement(__ds_scope.Badge, {
    variant: 'count',
    style: {
      fontSize: 10
    }
  }, subtasks) : null, age && !reference ? React.createElement('span', {
    className: 'cz-trow-age'
  }, age) : null, unread ? React.createElement(__ds_scope.StatusDot, {
    tone: 'violet',
    style: {
      marginLeft: 2
    }
  }) : null));
}
Object.assign(__ds_scope, { TaskRow });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/TaskRow.jsx", error: String((e && e.message) || e) }); }

// components/overlays/CommandPalette.jsx
try { (() => {
__ds_scope.css('cmdk', `.cz-cmdk{width:min(560px,100%);border-radius:var(--radius-lg);border:1px solid var(--border);background:var(--popover);color:var(--popover-foreground);box-shadow:var(--shadow-modal);overflow:hidden;font:400 14px/1.4 var(--sans)}
.cz-cmdk-in{display:flex;align-items:center;gap:8px;height:48px;padding:0 12px;border-bottom:1px solid var(--border)}.cz-cmdk-in input{flex:1;height:100%;border:0;background:transparent;outline:none;color:inherit;font:inherit}.cz-cmdk-in svg{color:var(--soft-foreground)}
.cz-cmdk-list{max-height:300px;overflow:auto;padding:4px}.cz-cmdk-g{padding:6px 8px 4px;font:500 12px var(--sans);color:var(--muted-foreground)}
.cz-cmdk-it{display:flex;align-items:center;gap:8px;border-radius:var(--radius-sm);padding:6px 8px;cursor:default}.cz-cmdk-it[data-active=true]{background:var(--accent)}.cz-cmdk-it>svg{color:var(--muted-foreground)}.cz-cmdk-it kbd{margin-left:auto;font:500 10.5px var(--mono);color:var(--muted-foreground);border:1px solid var(--border);border-bottom-width:2px;border-radius:5px;padding:1px 5px;background:var(--card)}`);
function CommandPalette({
  placeholder = 'Type a command or search…',
  groups = [],
  activeIndex = 0,
  style
}) {
  let i = -1;
  return React.createElement('div', {
    role: 'dialog',
    className: 'cz-cmdk',
    style
  }, React.createElement('div', {
    className: 'cz-cmdk-in'
  }, React.createElement(__ds_scope.Icon, {
    name: 'search',
    size: 16
  }), React.createElement('input', {
    placeholder,
    'aria-label': 'Search'
  })), React.createElement('div', {
    className: 'cz-cmdk-list',
    role: 'listbox'
  }, groups.map(g => React.createElement('div', {
    key: g.heading
  }, React.createElement('div', {
    className: 'cz-cmdk-g'
  }, g.heading), g.items.map(it => {
    i++;
    return React.createElement('div', {
      key: it.label,
      role: 'option',
      'aria-selected': i === activeIndex,
      'data-active': i === activeIndex ? 'true' : undefined,
      className: 'cz-cmdk-it'
    }, it.icon ? React.createElement(__ds_scope.Icon, {
      name: it.icon,
      size: 16
    }) : null, it.label, it.shortcut ? React.createElement('kbd', null, it.shortcut) : null);
  })))));
}
Object.assign(__ds_scope, { CommandPalette });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/overlays/CommandPalette.jsx", error: String((e && e.message) || e) }); }

// components/overlays/Dialog.jsx
try { (() => {
__ds_scope.css('dialog', `.cz-overlay{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.5)}.cz-overlay[data-inline=true]{position:absolute}
.cz-dialog{position:fixed;top:50%;left:50%;z-index:50;display:grid;width:100%;max-width:min(512px,calc(100% - 32px));transform:translate(-50%,-50%);gap:16px;border-radius:var(--radius-lg);border:1px solid var(--border);background:var(--card);padding:24px;box-shadow:var(--shadow-modal);outline:none;color:var(--foreground)}.cz-overlay[data-inline=true] .cz-dialog{position:absolute}
.cz-dialog-x{position:absolute;top:16px;right:16px;border:0;background:none;color:inherit;opacity:.7;cursor:pointer;border-radius:var(--radius-sm);padding:0;display:flex}.cz-dialog-x:hover{opacity:1}
.cz-dialog-h{display:flex;flex-direction:column;gap:8px}.cz-dialog-t{font:600 18px/1 var(--sans)}.cz-dialog-d{font:400 14px/1.45 var(--sans);color:var(--muted-foreground)}.cz-dialog-f{display:flex;gap:8px;justify-content:flex-end}`);
function Dialog({
  open = true,
  onOpenChange,
  title,
  description,
  children,
  footer,
  showClose = true,
  inline = false,
  width
}) {
  if (!open) return null;
  return React.createElement('div', {
    className: 'cz-overlay',
    'data-inline': inline ? 'true' : undefined,
    onClick: () => onOpenChange && onOpenChange(false)
  }, React.createElement('div', {
    role: 'dialog',
    'aria-modal': 'true',
    className: 'cz-dialog',
    style: width ? {
      maxWidth: width
    } : undefined,
    onClick: e => e.stopPropagation()
  }, title || description ? React.createElement('div', {
    className: 'cz-dialog-h'
  }, title ? React.createElement('h2', {
    className: 'cz-dialog-t',
    style: {
      margin: 0
    }
  }, title) : null, description ? React.createElement('p', {
    className: 'cz-dialog-d',
    style: {
      margin: 0
    }
  }, description) : null) : null, children, footer ? React.createElement('div', {
    className: 'cz-dialog-f'
  }, footer) : null, showClose ? React.createElement('button', {
    type: 'button',
    className: 'cz-dialog-x',
    'aria-label': 'Close',
    onClick: () => onOpenChange && onOpenChange(false)
  }, React.createElement(__ds_scope.Icon, {
    name: 'x',
    size: 16
  })) : null));
}
function AlertDialog({
  open = true,
  title,
  description,
  cancelLabel = 'Cancel',
  actionLabel = 'Continue',
  destructive = false,
  onCancel,
  onAction,
  inline = false
}) {
  return React.createElement(Dialog, {
    open,
    title,
    description,
    showClose: false,
    inline,
    onOpenChange: () => onCancel && onCancel(),
    footer: [React.createElement(__ds_scope.Button, {
      key: 'c',
      variant: 'outline',
      onClick: onCancel
    }, cancelLabel), React.createElement(__ds_scope.Button, {
      key: 'a',
      variant: destructive ? 'danger-ghost' : 'contrast',
      onClick: onAction
    }, actionLabel)]
  });
}
Object.assign(__ds_scope, { Dialog, AlertDialog });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/overlays/Dialog.jsx", error: String((e && e.message) || e) }); }

// components/overlays/DropdownMenu.jsx
try { (() => {
__ds_scope.css('menu', `.cz-menu{z-index:50;min-width:128px;overflow:hidden;border-radius:var(--radius);border:1px solid var(--border);background:var(--popover);color:var(--popover-foreground);padding:4px;box-shadow:var(--shadow-md);font:400 14px/1.4 var(--sans)}
.cz-menu-item{position:relative;display:flex;width:100%;align-items:center;gap:8px;border-radius:var(--radius-sm);padding:6px 8px;border:0;background:none;color:inherit;text-align:left;cursor:default;user-select:none;font:inherit}.cz-menu-item:hover,.cz-menu-item:focus{background:var(--accent);outline:none}.cz-menu-item[data-disabled=true]{pointer-events:none;opacity:.5}.cz-menu-item[data-variant=destructive]{color:var(--destructive)}.cz-menu-item[data-variant=destructive]:hover{background:color-mix(in srgb,var(--destructive) 10%,transparent)}
.cz-menu-item>svg{color:var(--muted-foreground)}.cz-menu-item[data-variant=destructive]>svg{color:var(--destructive)}
.cz-menu-label{padding:6px 8px;font:500 14px var(--sans)}.cz-menu-label[data-quiet=true]{font-size:12px;color:var(--soft-foreground)}.cz-menu-sep{margin:4px -4px;height:1px;background:var(--border)}.cz-menu-sc{margin-left:auto;font-size:12px;letter-spacing:.1em;color:var(--muted-foreground)}
.cz-menu-desc{display:flex;flex-direction:column;min-width:0}.cz-menu-desc b{font:500 12.5px/1.3 var(--sans)}.cz-menu-desc small{font:400 11.5px/1.3 var(--sans);color:var(--muted-foreground)}
.cz-menu-radio{width:14px;display:inline-flex;justify-content:center}`);
function DropdownMenu({
  items = [],
  style,
  className,
  width
}) {
  return React.createElement('div', {
    role: 'menu',
    className: __ds_scope.cx('cz-menu', className),
    style: {
      width,
      ...style
    }
  }, items.map((it, i) => {
    if (it.type === 'separator') return React.createElement('div', {
      key: i,
      className: 'cz-menu-sep'
    });
    if (it.type === 'label') return React.createElement('div', {
      key: i,
      className: 'cz-menu-label',
      'data-quiet': it.quiet ? 'true' : undefined
    }, it.label);
    return React.createElement('button', {
      key: i,
      type: 'button',
      role: it.checked !== undefined ? 'menuitemradio' : 'menuitem',
      'aria-checked': it.checked,
      'data-disabled': it.disabled ? 'true' : undefined,
      'data-variant': it.destructive ? 'destructive' : undefined,
      className: 'cz-menu-item',
      onClick: it.onSelect
    }, it.checked !== undefined ? React.createElement('span', {
      className: 'cz-menu-radio'
    }, it.checked ? React.createElement('span', {
      style: {
        width: 8,
        height: 8,
        borderRadius: 999,
        background: 'currentColor'
      }
    }) : null) : null, it.icon ? React.createElement(__ds_scope.Icon, {
      name: it.icon,
      size: 16
    }) : null, it.desc ? React.createElement('span', {
      className: 'cz-menu-desc'
    }, React.createElement('b', null, it.label), React.createElement('small', null, it.desc)) : it.label, it.shortcut ? React.createElement('span', {
      className: 'cz-menu-sc'
    }, it.shortcut) : null);
  }));
}
function Popover({
  children,
  style,
  className
}) {
  return React.createElement('div', {
    role: 'dialog',
    className: __ds_scope.cx('cz-menu', className),
    style: {
      width: 288,
      padding: 16,
      ...style
    }
  }, children);
}
Object.assign(__ds_scope, { DropdownMenu, Popover });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/overlays/DropdownMenu.jsx", error: String((e && e.message) || e) }); }

// components/overlays/Sheet.jsx
try { (() => {
__ds_scope.css('sheet', `.cz-sheet{position:fixed;top:0;bottom:0;z-index:50;display:flex;flex-direction:column;background:var(--card);border-color:var(--border);box-shadow:var(--shadow-modal);width:min(384px,100%);color:var(--foreground)}
.cz-sheet[data-inline=true]{position:absolute}.cz-sheet[data-side=left]{left:0;border-right:1px solid var(--border)}.cz-sheet[data-side=right]{right:0;border-left:1px solid var(--border)}
.cz-sheet-h{display:flex;align-items:center;gap:8px;padding:16px;font:600 16px/1 var(--sans)}.cz-sheet-b{flex:1;overflow:auto;padding:0 16px 16px;font:400 14px/1.5 var(--sans)}.cz-sheet-x{margin-left:auto}`);
function Sheet({
  open = true,
  side = 'right',
  title,
  children,
  onOpenChange,
  inline = false,
  width,
  bare = false
}) {
  if (!open) return null;
  return React.createElement('div', {
    className: 'cz-overlay',
    'data-inline': inline ? 'true' : undefined,
    onClick: () => onOpenChange && onOpenChange(false)
  }, React.createElement('div', {
    role: 'dialog',
    'aria-modal': 'true',
    className: 'cz-sheet',
    'data-side': side,
    'data-inline': inline ? 'true' : undefined,
    style: width ? {
      width
    } : undefined,
    onClick: e => e.stopPropagation()
  }, bare ? children : [React.createElement('div', {
    key: 'h',
    className: 'cz-sheet-h'
  }, title, React.createElement(__ds_scope.Button, {
    variant: 'ghost',
    size: 'icon-sm',
    className: 'cz-sheet-x',
    'aria-label': 'Close',
    onClick: () => onOpenChange && onOpenChange(false)
  }, React.createElement(__ds_scope.Icon, {
    name: 'x',
    size: 16
  }))), React.createElement('div', {
    key: 'b',
    className: 'cz-sheet-b'
  }, children)]));
}
Object.assign(__ds_scope, { Sheet });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/overlays/Sheet.jsx", error: String((e && e.message) || e) }); }

// components/overlays/Toast.jsx
try { (() => {
function Toast({
  tone = 'default',
  children,
  style
}) {
  return React.createElement('div', {
    role: 'status',
    'data-slot': 'toast',
    'data-tone': tone,
    style: {
      maxWidth: 'min(360px,calc(100vw - 32px))',
      borderRadius: 'var(--radius)',
      padding: '10px 14px',
      font: '500 13px/1.4 var(--sans)',
      boxShadow: 'var(--shadow-modal)',
      background: tone === 'danger' ? 'var(--danger)' : 'var(--contrast)',
      color: tone === 'danger' ? 'var(--danger-foreground)' : 'var(--contrast-foreground)',
      width: 'fit-content',
      ...style
    }
  }, children);
}
function Toaster({
  children,
  style
}) {
  return React.createElement('div', {
    'data-slot': 'toaster',
    style: {
      position: 'fixed',
      top: 16,
      right: 16,
      zIndex: 60,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end',
      gap: 8,
      pointerEvents: 'none',
      ...style
    }
  }, children);
}
Object.assign(__ds_scope, { Toast, Toaster });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/overlays/Toast.jsx", error: String((e && e.message) || e) }); }

// components/overlays/Tooltip.jsx
try { (() => {
function Tooltip({
  children,
  side = 'top',
  style
}) {
  const arrow = {
    top: {
      bottom: -4,
      left: 'calc(50% - 5px)'
    },
    bottom: {
      top: -4,
      left: 'calc(50% - 5px)'
    },
    left: {
      right: -4,
      top: 'calc(50% - 5px)'
    },
    right: {
      left: -4,
      top: 'calc(50% - 5px)'
    }
  }[side];
  return React.createElement('span', {
    role: 'tooltip',
    'data-side': side,
    style: {
      position: 'relative',
      display: 'inline-block',
      width: 'fit-content',
      borderRadius: 'var(--radius)',
      background: 'var(--contrast)',
      color: 'var(--contrast-foreground)',
      padding: '6px 12px',
      font: '400 12px/1.4 var(--sans)',
      textWrap: 'balance',
      ...style
    }
  }, children, React.createElement('span', {
    'aria-hidden': 'true',
    style: {
      position: 'absolute',
      width: 10,
      height: 10,
      background: 'var(--contrast)',
      transform: 'rotate(45deg)',
      borderRadius: 2,
      ...arrow
    }
  }));
}
Object.assign(__ds_scope, { Tooltip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/overlays/Tooltip.jsx", error: String((e && e.message) || e) }); }

// components/thread/CenteredState.jsx
try { (() => {
__ds_scope.css('centered', `.cz-cs{position:relative;isolation:isolate;display:flex;min-height:100%;flex:1;flex-direction:column;align-items:center;justify-content:center;padding:48px 24px;text-align:center}
.cz-cs-in{display:flex;width:100%;max-width:448px;flex-direction:column;align-items:center;gap:16px}
.cz-cs-tile{display:flex;width:72px;height:72px;align-items:center;justify-content:center;border-radius:18px;border:1px solid var(--border);background:var(--card);color:var(--foreground);box-shadow:var(--shadow-xs)}
.cz-cs[data-tone=primary] .cz-cs-tile{border-color:color-mix(in srgb,var(--primary) 25%,transparent);background:color-mix(in srgb,var(--primary) 15%,transparent);color:var(--primary);box-shadow:none}
.cz-cs[data-tone=danger] .cz-cs-tile{border-color:color-mix(in srgb,var(--danger) 20%,transparent);background:color-mix(in srgb,var(--danger) 15%,transparent);color:var(--danger);box-shadow:none}
.cz-cs h1{margin:0;font:600 24px/1.2 var(--sans);text-wrap:balance;color:var(--foreground)}.cz-cs p{margin:0;font:400 14px/1.5 var(--sans);text-wrap:pretty;color:var(--muted-foreground)}.cz-cs-a{display:flex;align-items:center;justify-content:center;gap:12px;padding-top:8px}
.cz-tw{pointer-events:none;position:absolute;inset:0;z-index:-1;overflow:hidden;-webkit-mask-image:linear-gradient(to bottom,black 25%,transparent 88%);mask-image:linear-gradient(to bottom,black 25%,transparent 88%)}.cz-tw i{position:absolute;border-radius:1px;animation:cez-pulse 3.5s ease-in-out infinite}`);
const TW = [[6, 14, 2, 'violet', .5], [11, 31, 3, 'violet', .45], [8, 52, 2, 'pending', .4], [15, 71, 2, 'violet', .5], [9, 86, 3, 'primary', .4], [22, 8, 2, 'pending', .4], [27, 24, 2, 'primary', .35], [20, 44, 3, 'violet', .35], [25, 62, 2, 'violet', .4], [30, 79, 2, 'primary', .35], [36, 12, 3, 'violet', .3], [42, 35, 2, 'pending', .28], [47, 58, 2, 'primary', .28], [52, 88, 2, 'violet', .25], [60, 29, 3, 'violet', .22]];
function TwinkleBackdrop({
  style
}) {
  return React.createElement('div', {
    'aria-hidden': 'true',
    className: 'cz-tw',
    style
  }, TW.map(([t, l, s, c, o], i) => React.createElement('i', {
    key: i,
    style: {
      top: t + '%',
      left: l + '%',
      width: s,
      height: s,
      background: 'var(--' + c + ')',
      opacity: o,
      animationDelay: i % 5 * 700 + 'ms'
    }
  })));
}
function CenteredState({
  icon,
  tone = 'neutral',
  title,
  subtitle,
  children,
  actions,
  backdrop = false,
  style
}) {
  return React.createElement('div', {
    'data-slot': 'centered-state',
    'data-tone': tone,
    className: 'cz-cs',
    style
  }, backdrop ? React.createElement(TwinkleBackdrop) : null, React.createElement('div', {
    className: 'cz-cs-in'
  }, React.createElement('div', {
    className: 'cz-cs-tile'
  }, typeof icon === 'string' ? React.createElement(__ds_scope.Icon, {
    name: icon,
    size: 28
  }) : icon), React.createElement('h1', null, title), subtitle ? React.createElement('p', null, subtitle) : null, children, actions ? React.createElement('div', {
    className: 'cz-cs-a'
  }, actions) : null));
}
Object.assign(__ds_scope, { TwinkleBackdrop, CenteredState });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/thread/CenteredState.jsx", error: String((e && e.message) || e) }); }

// components/thread/Collapsible.jsx
try { (() => {
__ds_scope.css('coll', `.cz-coll-t{display:flex;width:100%;align-items:center;gap:6px;border:0;background:none;color:var(--muted-foreground);font:500 13px/1 var(--sans);padding:0 8px;height:34px;border-radius:var(--radius);cursor:pointer;text-align:left}.cz-coll-t:hover{background:var(--muted);color:var(--foreground)}
.cz-coll-t svg{color:var(--soft-foreground);transition:transform .15s}.cz-coll[data-open=true] .cz-coll-t svg{transform:rotate(90deg)}
.cz-coll[data-quiet=true] .cz-coll-t{height:auto;padding:2px;font:400 12px/1.4 var(--sans);color:var(--soft-foreground)}.cz-coll[data-quiet=true] .cz-coll-t:hover{background:none;color:var(--muted-foreground)}`);
function Collapsible({
  label,
  defaultOpen = false,
  open,
  onOpenChange,
  quiet = false,
  children,
  className,
  style
}) {
  const [inner, setInner] = React.useState(defaultOpen);
  const isOpen = open !== undefined ? open : inner;
  return React.createElement('div', {
    'data-slot': 'collapsible',
    'data-open': isOpen ? 'true' : 'false',
    'data-quiet': quiet ? 'true' : undefined,
    className: __ds_scope.cx('cz-coll', className),
    style
  }, React.createElement('button', {
    type: 'button',
    'aria-expanded': isOpen,
    className: 'cz-coll-t',
    onClick: () => {
      const n = !isOpen;
      if (open === undefined) setInner(n);
      onOpenChange && onOpenChange(n);
    }
  }, React.createElement(__ds_scope.Icon, {
    name: 'chevron-right',
    size: 14
  }), label), isOpen ? React.createElement('div', {
    style: {
      paddingTop: 6,
      paddingLeft: 16,
      display: 'flex',
      flexDirection: 'column',
      gap: 6
    }
  }, children) : null);
}
Object.assign(__ds_scope, { Collapsible });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/thread/Collapsible.jsx", error: String((e && e.message) || e) }); }

// components/thread/Reasoning.jsx
try { (() => {
__ds_scope.css('reason', `.cz-reason{display:flex;width:100%;align-items:center;gap:6px;border:0;background:none;border-radius:var(--radius);padding:2px;text-align:left;font:400 13px/1.4 var(--sans);color:var(--soft-foreground);cursor:pointer}.cz-reason:hover{color:var(--muted-foreground)}.cz-reason svg{transition:transform .15s}.cz-reason[aria-expanded=true] svg{transform:rotate(90deg)}.cz-reason em{font-style:normal;color:var(--muted-foreground);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cz-reason-b{padding:6px 24px;font:400 13px/1.6 var(--sans);color:var(--soft-foreground);white-space:pre-wrap}
.cz-working{display:flex;align-items:center;gap:8px;padding:4px 0;font:500 13px/1 var(--sans);color:var(--soft-foreground)}`);
function Reasoning({
  text = '',
  defaultOpen = false
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const first = text.split('\n')[0] || '';
  return React.createElement('div', {
    'data-slot': 'reasoning'
  }, React.createElement('button', {
    type: 'button',
    'aria-expanded': open,
    className: 'cz-reason',
    onClick: () => setOpen(o => !o)
  }, React.createElement(__ds_scope.Icon, {
    name: 'chevron-right',
    size: 14
  }), React.createElement('span', {
    style: {
      flexShrink: 0
    }
  }, 'Thinking — '), React.createElement('em', null, first), first.length < text.length ? '…' : null), open ? React.createElement('div', {
    className: 'cz-reason-b'
  }, text) : null);
}
function WorkingIndicator({
  label = 'Working…'
}) {
  return React.createElement('div', {
    'data-slot': 'working-indicator',
    className: 'cz-working'
  }, React.createElement(__ds_scope.Icon, {
    name: 'loader-circle',
    size: 14,
    className: 'cz-spin',
    style: {
      animation: 'cez-spin 1s linear infinite'
    }
  }), React.createElement('span', {
    className: 'cez-shimmer'
  }, label));
}
Object.assign(__ds_scope, { Reasoning, WorkingIndicator });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/thread/Reasoning.jsx", error: String((e && e.message) || e) }); }

// components/thread/ToolCard.jsx
try { (() => {
__ds_scope.css('tool', `.cz-tool{min-width:0;overflow:hidden;border-radius:var(--radius);border:1px solid var(--border);background:var(--card)}.cz-tool[data-status=failed]{border-color:color-mix(in srgb,var(--danger) 25%,transparent)}
.cz-tool-t{display:flex;min-height:28px;width:100%;align-items:center;gap:6px;padding:2px 10px;border:0;background:none;color:inherit;text-align:left;font:400 13px/1.4 var(--sans);cursor:pointer}.cz-tool-t:disabled{cursor:default}.cz-tool-t:enabled:hover{background:var(--muted)}
.cz-tool-chev{color:var(--soft-foreground);transition:transform .15s}.cz-tool[data-open=true] .cz-tool-chev{transform:rotate(90deg)}.cz-tool-chev[data-hidden=true]{visibility:hidden}
.cz-tool-ic{color:var(--muted-foreground)}.cz-tool-verb{flex-shrink:0;font-weight:600}.cz-tool-verb[data-declined=true]{color:var(--muted-foreground)}.cz-tool-det{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:400 12px/1.4 var(--mono);color:var(--muted-foreground)}
.cz-tool-r{margin-left:auto;display:flex;flex-shrink:0;align-items:center;gap:8px;padding-left:8px;font:400 12px var(--sans);color:var(--muted-foreground)}.cz-tool-exit{border-radius:999px;padding:1px 8px;font:600 10.5px/1.4 var(--mono)}.cz-tool-exit[data-ok=true]{background:color-mix(in srgb,var(--success) 10%,transparent);color:var(--success)}.cz-tool-exit[data-ok=false]{background:color-mix(in srgb,var(--danger) 10%,transparent);color:var(--danger)}
.cz-tool-b{border-top:1px solid var(--border);background:var(--card-2)}.cz-tool-out{margin:0;padding:12px 16px;overflow-x:auto;font:400 12px/1.7 var(--mono);white-space:pre;color:var(--muted-foreground)}.cz-tool-err{padding:12px 16px;font:400 12px/1.7 var(--mono);white-space:pre-wrap;color:var(--danger)}
.cz-tool-diffp{border-bottom:1px solid color-mix(in srgb,var(--border) 50%,transparent);padding:6px 16px;font:400 11px var(--mono);color:var(--soft-foreground)}.cz-tool-diff{margin:0;padding:8px 0;overflow-x:auto;font:400 12px/1.7 var(--mono);white-space:pre}.cz-tool-diff span{display:block;padding:0 16px}.cz-tool-diff span[data-k=add]{background:var(--diff-add-bg)}.cz-tool-diff span[data-k=del]{background:var(--diff-del-bg);color:var(--muted-foreground)}.cz-tool-diff span[data-k=hunk]{color:var(--soft-foreground)}
.cz-spin{animation:cez-spin 1s linear infinite;color:var(--soft-foreground)}`);
const ICONS = {
  read: 'file-text',
  edit: 'square-pen',
  delete: 'trash-2',
  move: 'folder-input',
  search: 'search',
  execute: 'square-terminal',
  think: 'brain',
  fetch: 'globe',
  task: 'bot',
  plan: 'list-todo',
  other: 'wrench'
};
function ToolCard({
  kind = 'other',
  status = 'done',
  verb,
  detail,
  output,
  error,
  diff,
  exitCode,
  defaultOpen,
  children
}) {
  const busy = status === 'running' || status === 'pending';
  const hasDetail = Boolean(output || error || diff || children);
  const [open, setOpen] = React.useState(defaultOpen !== undefined ? defaultOpen : kind === 'execute' && status === 'running' && !!output);
  const isOpen = hasDetail && open;
  return React.createElement('div', {
    'data-slot': 'tool-card',
    'data-status': status,
    'data-kind': kind,
    'data-open': isOpen ? 'true' : 'false',
    className: 'cz-tool'
  }, React.createElement('button', {
    type: 'button',
    className: 'cz-tool-t',
    disabled: !hasDetail,
    'aria-expanded': isOpen,
    onClick: () => setOpen(o => !o)
  }, React.createElement(__ds_scope.Icon, {
    name: 'chevron-right',
    size: 12,
    className: 'cz-tool-chev',
    'data-hidden': hasDetail ? undefined : 'true'
  }), React.createElement(__ds_scope.Icon, {
    name: ICONS[kind] || 'wrench',
    size: 14,
    className: 'cz-tool-ic'
  }), React.createElement('span', {
    className: __ds_scope.cx('cz-tool-verb', busy && 'cez-shimmer'),
    'data-declined': status === 'declined' ? 'true' : undefined
  }, verb), detail ? React.createElement('code', {
    className: 'cz-tool-det'
  }, detail) : null, React.createElement('span', {
    className: 'cz-tool-r'
  }, busy ? React.createElement(__ds_scope.Icon, {
    name: 'loader-circle',
    size: 14,
    className: 'cz-spin',
    role: 'status',
    'aria-label': 'Running'
  }) : null, status === 'failed' ? 'failed' : null, status === 'declined' ? React.createElement('span', {
    style: {
      color: 'var(--soft-foreground)'
    }
  }, 'declined') : null, kind === 'execute' && typeof exitCode === 'number' ? React.createElement('span', {
    className: 'cz-tool-exit',
    'data-ok': exitCode === 0 ? 'true' : 'false'
  }, exitCode) : null)), isOpen ? React.createElement('div', {
    className: 'cz-tool-b'
  }, error ? React.createElement('div', {
    className: 'cz-tool-err'
  }, error) : null, diff ? [React.createElement('div', {
    key: 'p',
    className: 'cz-tool-diffp'
  }, diff.path), React.createElement('pre', {
    key: 'd',
    className: 'cz-tool-diff'
  }, diff.lines.map((l, i) => React.createElement('span', {
    key: i,
    'data-k': l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : undefined
  }, l)))] : null, output ? React.createElement('pre', {
    className: 'cz-tool-out'
  }, output) : null, children ? React.createElement('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      borderLeft: '2px solid var(--border)',
      margin: '8px 12px 8px 16px',
      padding: '10px 12px'
    }
  }, children) : null) : null);
}
Object.assign(__ds_scope, { ToolCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/thread/ToolCard.jsx", error: String((e && e.message) || e) }); }

// components/thread/UserBubble.jsx
try { (() => {
__ds_scope.css('bubble', `.cz-bubble{max-width:70%;min-width:0;align-self:flex-end;border-radius:16px;border-bottom-right-radius:10px;background:var(--muted);padding:10px 15px;font:400 13.5px/1.55 var(--sans);color:var(--foreground)}
.cz-bubble-att{margin-top:8px;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px}.cz-bubble-file{display:inline-flex;max-width:220px;align-items:center;gap:6px;border-radius:var(--radius);border:1px solid var(--border);background:color-mix(in srgb,var(--background) 60%,transparent);padding:4px 8px;font:400 12px/1.4 var(--sans);color:var(--muted-foreground)}
.cz-assist{min-width:0;font:400 15px/1.65 var(--sans);color:var(--foreground)}.cz-assist code{border-radius:5px;background:var(--muted);padding:1.5px 5px;font-size:.9em}
.cz-note{padding:0 2px;font:400 12px/1.5 var(--sans);color:var(--soft-foreground)}.cz-note[data-tone=danger]{color:var(--danger)}`);
function UserBubble({
  children,
  files = [],
  style
}) {
  return React.createElement('div', {
    'data-slot': 'user-bubble',
    className: 'cz-bubble',
    style
  }, children, files.length ? React.createElement('span', {
    className: 'cz-bubble-att'
  }, files.map(f => React.createElement('a', {
    key: f,
    className: 'cz-bubble-file',
    href: '#'
  }, React.createElement(__ds_scope.Icon, {
    name: 'paperclip',
    size: 14
  }), React.createElement('span', {
    style: {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }
  }, f)))) : null);
}
function AssistantMessage({
  children,
  style
}) {
  return React.createElement('div', {
    'data-slot': 'assistant-message',
    className: 'cz-assist',
    style
  }, children);
}
function NoteLine({
  tone = 'neutral',
  children
}) {
  return React.createElement('div', {
    'data-slot': 'note-line',
    'data-tone': tone,
    className: 'cz-note'
  }, tone === 'danger' ? '✗ ' : '· ', children);
}
Object.assign(__ds_scope, { UserBubble, AssistantMessage, NoteLine });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/thread/UserBubble.jsx", error: String((e && e.message) || e) }); }

// ui_kits/cockpit/AutomationsScreen.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const {
  Pill,
  StatusDot,
  Button,
  Icon,
  Segmented,
  Input,
  Textarea,
  Card,
  Chip,
  Kbd,
  Label,
  Switch,
  Select,
  BranchChip,
  DropdownMenu,
  CenteredState,
  TabBar,
  TabLink,
  Sheet
} = window.CezarDesignSystem_3b4141;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const pad = n => String(n).padStart(2, '0');
const hm = (h, m = 0) => pad(h) + ':' + pad(m);
