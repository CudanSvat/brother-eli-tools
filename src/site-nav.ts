import { SITE } from "./config";

export type SiteNavPage = "tools" | "revoke";

const ASSETS = `${SITE}/assets/believe/shared-masthead-v5`;

/** Same destinations as brothereli.com BrandMasthead (mint + marketplace live). */
const LINKS: [string, string][] = [
  ["/memes", "MEMES"],
  ["/mint", "MINT AN ELI"],
  ["/marketplace", "MARKETPLACE"],
  ["/bridge", "BRIDGE"],
  ["/launchpad", "LAUNCHPAD"],
  ["/tools/", "TOOLS"],
];

function href(path: string): string {
  if (path.startsWith("/tools")) return path;
  return `${SITE}${path}`;
}

/** Paper-strip site nav for tools hub + revoke. GET $SLAY opens the main buy flow. */
export function siteNavHtml(current: SiteNavPage): string {
  const currentPath = current === "revoke" ? "/tools/revoke/" : "/tools/";
  const srcSet = (mode: "desktop" | "mobile") =>
    (mode === "mobile" ? [480, 960, 1440] : [1280, 2560, 4800])
      .map((w) => `${ASSETS}/shared-${mode}-${w}.webp ${w}w`)
      .join(", ");

  const links = LINKS.map(([path, label]) => {
    const here =
      path === "/tools/"
        ? current === "tools" || current === "revoke"
        : false;
    const ariaCurrent = here ? ` aria-current="page"` : "";
    return `<a class="sn-link" href="${href(path)}" aria-label="${label}"${ariaCurrent}>${label}</a>`;
  }).join("");

  return `<header class="site-nav" data-brand-masthead data-page="${currentPath}" data-has-action>
  <div class="sn-frame">
    <picture aria-hidden="true">
      <source media="(max-width: 899px)" srcset="${srcSet("mobile")}" sizes="(max-width: 348px) calc(100vw - 16px), 332px" width="1240" height="264" />
      <img src="${ASSETS}/shared-desktop-1280.webp" srcset="${srcSet("desktop")}" sizes="(min-width: 1232px) 900px, calc(100vw - 340px)" width="1636" height="102" alt="" decoding="async" fetchpriority="high" draggable="false" />
    </picture>
    <a class="sn-brand" href="${SITE}/" aria-label="Brother Eli home"></a>
    <nav aria-label="Brother Eli pages" data-site-navigation data-page="${currentPath}">${links}</nav>
  </div>
  <div class="sn-cluster">
    <a class="sn-buy" href="${SITE}/?buy=1" aria-label="Get SLAY">GET $SLAY</a>
  </div>
</header>`;
}
