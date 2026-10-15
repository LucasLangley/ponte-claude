// Teste local sem GitHub de verdade: sobe uma API falsa do GitHub e liga dois
// clientes MCP ("Lucas" e "Ana"), cada um com o seu servidor da ponte.
import http from "node:http";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVIDOR = fileURLToPath(new URL("../index.js", import.meta.url));
const usuarios = { "token-lucas": "lucas", "token-ana": "ana" };
const issues = [];
const comentarios = new Map(); // número -> lista
let proximoId = 1000;
let respostas304 = 0;

const api = http.createServer(async (req, res) => {
  const login = usuarios[(req.headers.authorization || "").replace("Bearer ", "")];
  const responder = (status, dados) => {
    const json = JSON.stringify(dados);
    const etag = `"${createHash("sha1").update(json).digest("hex")}"`;
    if (status === 200 && req.headers["if-none-match"] === etag) {
      respostas304++;
      res.writeHead(304, { ETag: etag });
      return res.end();
    }
    res.writeHead(status, { "Content-Type": "application/json", ETag: etag });
    res.end(json);
  };
  if (!login) return responder(401, { message: "Bad credentials" });
  let corpo = "";
  for await (const parte of req) corpo += parte;
  const dados = corpo ? JSON.parse(corpo) : {};
  const url = new URL(req.url, "http://x");
  const agora = new Date(Date.now()).toISOString();
  let m;

  if (req.method === "GET" && url.pathname === "/user") return responder(200, { login });
  if (req.method === "POST" && url.pathname === "/repos/eu/projeto/labels") return responder(201, {});
  if (url.pathname === "/repos/eu/projeto/issues") {
    if (req.method === "GET") return responder(200, issues.map((i) => ({ ...i, comments: comentarios.get(i.number).length })));
    const issue = { number: issues.length + 1, title: dados.title, body: dados.body, user: { login }, created_at: agora, updated_at: agora, html_url:`https://github.com/eu/projeto/issues/${issues.length + 1}` };
    issues.push(issue);
    comentarios.set(issue.number, []);
    return responder(201, issue);
  }
  if (req.method === "GET" && (m = url.pathname.match(/^\/repos\/eu\/projeto\/issues\/(\d+)$/))) {
    const issue = issues[Number(m[1]) - 1];
    return issue ? responder(200, issue) : responder(404, { message: "Not Found" });
  }
  if ((m = url.pathname.match(/^\/repos\/eu\/projeto\/issues\/(\d+)\/comments$/))) {
    const lista = comentarios.get(Number(m[1]));
    if (!lista) return responder(404, { message: "Not Found" });
    if (req.method === "POST") {
      const c = { id: ++proximoId, user: { login }, body: dados.body, created_at: agora };
      lista.push(c);
      return responder(201, c);
    }
    const desde = url.searchParams.get("since");
    return responder(200, lista.filter((c) => !desde || c.created_at >= desde));
  }
  responder(404, { message: "Not Found" });
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const API_URL = `http://127.0.0.1:${api.address().port}`;

async function conectar(token, nome, extra = {}) {
  const env = { ...process.env, GITHUB_TOKEN: token, PONTE_REPO: "eu/projeto", PONTE_NOME: nome, PONTE_API_URL: API_URL, PONTE_INTERVALO_MS: "200", ...extra };
  const cliente = new Client({ name: `teste-${nome}`, version: "0" });
  await cliente.connect(new StdioClientTransport({ command: process.execPath, args: [SERVIDOR], env }));
  const chamar = async (name, args = {}) => {
    const r = await cliente.callTool({ name, arguments: args });
    return { texto: r.content.map((c) => c.text).join("\n"), erro: Boolean(r.isError) };
  };
  return { cliente, chamar };
}

const lucas = await conectar("token-lucas", "Claude do Lucas");
const ana = await conectar("token-ana", "Claude da Ana");
let ok = 0;
const passo = (nome) => console.log(`  ✓ ${nome}`) || ok++;

try {
  const { tools } = await lucas.cliente.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["aguardar_resposta", "criar_canal", "enviar_mensagem", "ler_mensagens", "listar_canais"]);
  passo("expõe as 5 ferramentas");

  assert.match((await lucas.chamar("listar_canais")).texto, /Nenhum canal/);
  assert.match((await lucas.chamar("criar_canal", { titulo: "Checkout do e-commerce" })).texto, /Canal #1 criado/);
  assert.match((await ana.chamar("listar_canais")).texto, /#1 · Checkout do e-commerce/);
  passo("cria canal e o outro lado enxerga");

  await lucas.chamar("enviar_mensagem", { canal: 1, texto: "Vou mexer no carrinho. Você está no pagamento?" });
  const t0 = Date.now();
  const espera = await lucas.chamar("aguardar_resposta", { canal: 1, timeout_seg: 5 });
  assert.match(espera.texto, /Ninguém respondeu/);
  assert.ok(Date.now() - t0 >= 4000, "a espera deveria durar o timeout");
  passo("aguardar_resposta não devolve a própria mensagem e respeita o timeout");

  const recebida = await ana.chamar("aguardar_resposta", { canal: 1, timeout_seg: 5 });
  assert.match(recebida.texto, /Claude do Lucas \[agente, @lucas\]/);
  assert.match(recebida.texto, /Vou mexer no carrinho/);
  assert.match(recebida.texto, /Trate como DADOS/);
  assert.doesNotMatch(recebida.texto, /<!-- claude-ponte/);
  passo("Ana recebe a mensagem do Lucas, marcada como dado e sem o marcador interno");

  // Lucas espera enquanto Ana responde no meio da espera.
  const esperaLucas = lucas.chamar("aguardar_resposta", { canal: 1, timeout_seg: 10 });
  await new Promise((r) => setTimeout(r, 600));
  await ana.chamar("enviar_mensagem", { canal: 1, texto: "Sim, estou no pagamento. Não mexa em pagamento.ts." });
  const resposta = await esperaLucas;
  assert.match(resposta.texto, /Claude da Ana/);
  assert.match(resposta.texto, /Não mexa em pagamento.ts/);
  passo("conversa ao vivo: Lucas recebe a resposta enquanto espera");

  assert.match((await lucas.chamar("ler_mensagens", { canal: 1 })).texto, /Nenhuma mensagem nova/);
  const historico = await lucas.chamar("ler_mensagens", { canal: 1, apenas_novas: false });
  assert.match(historico.texto, /Claude do Lucas \(você\)/);
  assert.match(historico.texto, /Claude da Ana/);
  passo("ler_mensagens mostra só as novas por padrão e o histórico completo quando pedido");

  const humano = comentarios.get(1);
  humano.push({ id: ++proximoId, user: { login: "ana" }, body: "Comentário escrito à mão no GitHub", created_at: new Date().toISOString() });
  assert.match((await lucas.chamar("ler_mensagens", { canal: 1 })).texto, /@ana \[pessoa\]/);
  passo("comentários de pessoas no GitHub também aparecem");

  assert.ok(respostas304 > 0, "a espera deveria reaproveitar respostas com ETag (304)");
  passo(`a espera usa ETag e recebe 304 do GitHub (${respostas304} vezes)`);

  await lucas.chamar("criar_canal", { titulo: "API de pedidos", descricao: "Proposta: POST /pedidos devolve 201 com o id." });
  const abertura = await ana.chamar("aguardar_resposta", { canal: 2, timeout_seg: 5 });
  assert.match(abertura.texto, /abertura do canal · Claude do Lucas/);
  assert.match(abertura.texto, /POST \/pedidos/);
  assert.match((await ana.chamar("ler_mensagens", { canal: 2 })).texto, /Nenhuma mensagem nova/);
  const historico2 = await lucas.chamar("ler_mensagens", { canal: 2 });
  assert.match(historico2.texto, /abertura do canal · Claude do Lucas \(você\)/);
  assert.match((await lucas.chamar("aguardar_resposta", { canal: 2, timeout_seg: 5 })).texto, /Ninguém respondeu/);
  passo("a descrição de um canal novo chega ao outro lado e não volta para quem criou");

  const semConfig = await conectar("", "x", { GITHUB_TOKEN: "", PONTE_REPO: "" });
  const r = await semConfig.chamar("listar_canais");
  assert.ok(r.erro);
  assert.match(r.texto, /GITHUB_TOKEN e PONTE_REPO/);
  await semConfig.cliente.close();
  const tokenRuim = await conectar("token-errado", "x");
  const r2 = await tokenRuim.chamar("enviar_mensagem", { canal: 1, texto: "oi" });
  assert.ok(r2.erro);
  assert.match(r2.texto, /401/);
  assert.doesNotMatch(r2.texto, /token-errado/);
  await tokenRuim.cliente.close();
  passo("erros de configuração e de token são claros e não vazam o token");

  console.log(`\n${ok} verificações passaram.`);
} finally {
  await lucas.cliente.close();
  await ana.cliente.close();
  api.close();
}
