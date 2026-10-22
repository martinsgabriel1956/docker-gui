// A única coisa que muda entre a versão web (docker_gui.py, fetch/EventSource/WebSocket) e o desktop (Tauri, invoke/
// Channel). O app.ts importa '#transport': o package.json aponta para transport-web.ts e, com a condição "desktop" do
// esbuild (build.py --desktop), para transport-desktop.ts. Nenhum dos dois builds carrega o código do outro.

// json() é any como o do fetch: cada chamada diz o tipo que espera, como antes
export interface ApiResponse { ok: boolean; status: number; json(): Promise<any> }
export interface Closer { close(): void }
// o EventSource de hoje: open a cada (re)conexão, uma mensagem por linha, end quando o docker termina; error(closed)
// diz se desistiu de vez (recusa) ou se está reconectando
export interface StreamHandlers { open?(): void; data(line: string): void; end(): void; error(closed: boolean): void }
// o terminal: notice é um aviso do servidor em texto (no Windows, imagem sem TTY), que vai para a linha de status
export interface TermHandlers { open(): void; data(b: Uint8Array): void; notice(text: string): void; close(): void }
export interface Term { send(data: string): void; resize(cols: number, rows: number): void; close(): void }
export interface NdjsonResult { status: number; code: number; error?: unknown }
// preferências do app desktop (a versão web usa as flags e as variáveis de ambiente). null = o padrão de hoje
export interface Prefs { cli: string | null; context: string | null; lang: string | null; notifications: boolean; autostart: boolean }
export interface DesktopPrefs {
  get(): Promise<Prefs & {contexts: string[]}>;
  set(p: Prefs): Promise<string | null>;  // a mensagem de erro, ou null (a janela recarrega)
  onOpen(open: () => void): void;  // o "Preferências…" do menu da bandeja
}

export interface Transport {
  desktop: boolean;
  // path pode trazer a query (como hoje: /api/logs/<id>?tail=500)
  request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiResponse>;
  stream(path: string, query: Record<string, string>, on: StreamHandlers): Closer;
  // POST com resposta NDJSON (compose): cada linha string vai para onLine, o fim é {code} (-1 se o stream caiu antes);
  // recusa antes de o compose rodar (projeto que não existe): status de erro e o JSON da mensagem em error
  ndjson(path: string, body: unknown, onLine: (line: string) => void): Promise<NdjsonResult>;
  terminal(id: string, on: TermHandlers): Term;
  // contagem da faixa de atenção ("", "3", "9+", "!") e o ícone já desenhado: web vira favicon, desktop vira bandeja
  attention(badge: string, svg: string): void;
  notify(title: string, body: string, onClick: () => void): void;
  prefs?: DesktopPrefs;
  // "Abrir pasta" do projeto compose: só no desktop (a web copia o caminho). A mensagem de erro, ou null
  openDir?(project: string, dir: string): Promise<string | null>;
}
