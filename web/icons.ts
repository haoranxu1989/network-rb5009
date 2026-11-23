// One stroke weight for the console chrome, cards, and device list.
const paths = {
  network: '<rect x="3" y="3" width="18" height="18" rx="5"/><path d="M7 15.5 10 8l4 8 3-7.5"/>',
  notice: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3h.01"/>',
  overview: '<rect x="3" y="3" width="7" height="8" rx="1.6"/><rect x="14" y="3" width="7" height="5" rx="1.6"/><rect x="3" y="15" width="7" height="6" rx="1.6"/><rect x="14" y="12" width="7" height="9" rx="1.6"/>',
  activity: '<path d="M2 13h4l3-8 5 14 3-9 2 3h3"/>',
  clients: '<rect x="2" y="4" width="14" height="12" rx="2"/><path d="M6 20h7m-4-4v4"/><rect x="16" y="9" width="6" height="12" rx="1.7"/>',
  logs: '<rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M8 8h8M8 12h8m-8 4h5"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 6-2.5 7-2.5 8.5h17C20.5 15 18 14 18 8ZM10 20a2.5 2.5 0 0 0 4 0"/>',
  router: '<rect x="2" y="7" width="20" height="10" rx="2.5"/><path d="M5.5 12h.01m3 0h.01m3.5-1.5h3v3h-3zm5 0h2v3h-2z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  port: '<path d="M4 4h16v12h-3v3H7v-3H4zM8 6v4m4-4v4m4-4v4"/>',
  bolt: '<path d="m13.8 2.5-9.1 11H11l-.8 8 9.1-12.3H13z"/>',
  camera: '<path d="m3 6 12-3 4 6-11 5zM9 14l1 4h6m0-2v4"/>',
  drive: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 6v10m5-10v10M7 18.5h1m3 0h1"/>',
  tv: '<rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 21h8m-4-3v3"/>',
  console: '<path d="M8 7h8c3 0 4 2 5 6.5s0 5.5-2 5.5-3-3-5-3h-4c-2 0-3 3-5 3s-3-1-2-5.5S5 7 8 7Z"/><path d="M7.5 10v4m-2-2h4m6-1h.01m2 2h.01"/>',
  display: '<rect x="2" y="3" width="20" height="15" rx="2"/><path d="M8 21h8m-4-3v3"/>',
  search: '<circle cx="10" cy="10" r="6.5"/><path d="m15 15 5 5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>', back: '<path d="m10 5-7 7 7 7m-7-7h18"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>', 'chevron-right': '<path d="m9 5 7 7-7 7"/>',
  'arrow-down': '<path d="M12 4v16m-6-6 6 6 6-6"/>', 'arrow-up': '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  'arrow-right': '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  download: '<path d="M12 3v12m-4.5-4.5L12 15l4.5-4.5M4 16v4h16v-4"/>',
  upgrade: '<circle cx="12" cy="12" r="9"/><path d="M12 16V8m-3.5 3.5L12 8l3.5 3.5"/>',
  restart: '<path d="M20 10a8.2 8.2 0 1 0 .1 4.5M20 4v6h-6"/>',
  trash: '<path d="M3.5 6.5h17m-13.5 0 .9 12.7a1.5 1.5 0 0 0 1.5 1.3h5.2a1.5 1.5 0 0 0 1.5-1.3L17 6.5M9 6V4.5c0-.8.6-1.3 1.3-1.3h3.4c.7 0 1.3.5 1.3 1.3V6m-4.5 4v7m3-7v7"/>',
} as const;

export type IconName = keyof typeof paths;
export function icon(name: IconName): string {
  return '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + paths[name] + '</svg>';
}
export function mountIcons(): void {
  for (const node of document.querySelectorAll<HTMLElement>('[data-icon]')) {
    const name = node.dataset.icon as IconName;
    if (name in paths) node.innerHTML = icon(name);
  }
}
