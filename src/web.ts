// Links into the Plaud web app. app.plaud.ai redirects here, keeping the path.
export const WEB_ORIGIN = "https://web.plaud.ai";

export function webUrl(id: string): string {
  return `${WEB_ORIGIN}/file/${encodeURIComponent(id)}`;
}
