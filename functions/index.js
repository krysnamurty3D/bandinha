// Cloud Functions for Bandinha push notifications (auto-deploy, retry 6)
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { getMessaging } = require("firebase-admin/messaging");
const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { FieldValue } = require("firebase-admin/firestore");

const COORDENADOR_EMAIL = "krysnamurty@gmail.com";

initializeApp();
const db = getFirestore();

// ---------- Helpers multi-equipe ----------
// equipeId === null/undefined -> equipe legada (coleções no topo do banco)
function colPath(equipeId, nome) {
  return equipeId ? `equipes/${equipeId}/${nome}` : nome;
}
function docPath(equipeId, nome, id) {
  return equipeId ? `equipes/${equipeId}/${nome}/${id}` : `${nome}/${id}`;
}
function col(equipeId, nome) {
  return db.collection(colPath(equipeId, nome));
}
function docRef(equipeId, nome, id) {
  return db.doc(docPath(equipeId, nome, id));
}

async function todasEquipeIds() {
  const snap = await db.collection("equipes").get();
  return [null, ...snap.docs.map(d => d.id)];
}

async function sendToAll(equipeId, title, body, url) {
  const tokensSnap = await col(equipeId, "pushTokens").get();
  if (tokensSnap.empty) return;
  const tokens = tokensSnap.docs.map(d => d.id);
  const res = await getMessaging().sendEachForMulticast({
    tokens,
    data: { title, body, url: url || "publico.html" }
  });
  const invalidos = [];
  res.responses.forEach((r, i) => {
    if (!r.success && ["messaging/registration-token-not-registered", "messaging/invalid-registration-token"].includes(r.error?.code)) {
      invalidos.push(tokens[i]);
    }
  });
  await Promise.all(invalidos.map(t => col(equipeId, "pushTokens").doc(t).delete()));
}

async function notificacaoAtiva(equipeId, categoria) {
  const snap = await docRef(equipeId, "config", "notificacoes").get();
  const cfg = snap.exists ? snap.data() : {};
  return cfg[categoria] !== false;
}

const HISTORICO_LIMITE = 15;

async function registrarHistorico(equipeId, tipo, texto) {
  await col(equipeId, "avisosHistorico").add({ tipo, texto, disparadoEm: Date.now() });
  const snap = await col(equipeId, "avisosHistorico").orderBy("disparadoEm", "desc").offset(HISTORICO_LIMITE).get();
  await Promise.all(snap.docs.map(d => d.ref.delete()));
}

async function isCoordenadorDaEquipe(email, equipeId) {
  if (email === COORDENADOR_EMAIL) return true;
  if (!equipeId) return false;
  const snap = await db.collection("equipes").doc(equipeId).get();
  return snap.exists && (snap.data().coordenadores || []).includes(email);
}

// ---------- Triggers (legado + toda equipe, via par de exports) ----------
function registrarCriado(nome, colecao, handler) {
  exports[nome] = onDocumentCreated(`${colecao}/{id}`, event => handler(null, event));
  exports[nome + "Equipe"] = onDocumentCreated(`equipes/{equipeId}/${colecao}/{id}`, event => handler(event.params.equipeId, event));
}
function registrarAtualizado(nome, colecao, handler) {
  exports[nome] = onDocumentUpdated(`${colecao}/{id}`, event => handler(null, event));
  exports[nome + "Equipe"] = onDocumentUpdated(`equipes/{equipeId}/${colecao}/{id}`, event => handler(event.params.equipeId, event));
}
function registrarEscrito(nome, caminho, handler) {
  exports[nome] = onDocumentWritten(caminho, event => handler(null, event));
  exports[nome + "Equipe"] = onDocumentWritten(`equipes/{equipeId}/${caminho}`, event => handler(event.params.equipeId, event));
}

registrarCriado("onNovaAgenda", "agenda", async (equipeId, event) => {
  if (!(await notificacaoAtiva(equipeId, "agenda"))) return;
  const a = event.data.data();
  const titulo = a.titulo || "Novo dia marcado";
  await sendToAll(equipeId, "Nova data na Agenda", `${titulo} — ${a.data?.split("-").reverse().join("/") || ""}`);
});

registrarCriado("onNovoRoteiro", "roteiros", async (equipeId, event) => {
  if (!(await notificacaoAtiva(equipeId, "roteiros"))) return;
  const r = event.data.data();
  await sendToAll(equipeId, "Novo roteiro criado", r.titulo || "Roteiro do próximo encontro");
});

registrarCriado("onNovaMusica", "musicas", async (equipeId, event) => {
  const m = event.data.data();
  if (m.visivel === false) return;
  if (!(await notificacaoAtiva(equipeId, "musicas"))) return;
  await sendToAll(equipeId, "Nova música adicionada", m.nome || "");
});

registrarAtualizado("onMusicaRevelada", "musicas", async (equipeId, event) => {
  const antes = event.data.before.data();
  const depois = event.data.after.data();
  if (antes.visivel === false && depois.visivel !== false) {
    if (!(await notificacaoAtiva(equipeId, "musicas"))) return;
    await sendToAll(equipeId, "Nova música revelada", depois.nome || "");
  }
});

registrarEscrito("onCamisasAtivado", "config/camisas", async (equipeId, event) => {
  const antes = event.data.before.data() || {};
  const depois = event.data.after.data() || {};
  if (!antes.ativo && depois.ativo) {
    if (!(await notificacaoAtiva(equipeId, "camisas"))) return;
    await sendToAll(equipeId, "Campanha de camisas", "Escolha o tamanho da sua camisa!", "publico.html?tab=camisas");
  }
});

registrarCriado("onNovoDevocional", "devocionais", async (equipeId, event) => {
  const d = event.data.data();
  if (d.visivel === false) return;
  if (!(await notificacaoAtiva(equipeId, "devocionais"))) return;
  await sendToAll(equipeId, "Novo devocional", d.titulo || "");
});

registrarAtualizado("onDevocionalRevelado", "devocionais", async (equipeId, event) => {
  const antes = event.data.before.data();
  const depois = event.data.after.data();
  if (antes.visivel === false && depois.visivel !== false) {
    if (!(await notificacaoAtiva(equipeId, "devocionais"))) return;
    await sendToAll(equipeId, "Novo devocional", depois.titulo || "");
  }
});

exports.enviarAvisoAoVivo = onCall(async request => {
  const equipeId = request.data?.equipeId || null;
  const email = request.auth?.token?.email;
  if (!(await isCoordenadorDaEquipe(email, equipeId))) {
    throw new HttpsError("permission-denied", "Apenas o coordenador pode enviar avisos ao vivo.");
  }
  const { proximaEtapa, minutos, urgente, avisoAntesMin, mensagemCustom } = request.data || {};
  const aoVivoRef = docRef(equipeId, "aoVivo", "atual");
  if (mensagemCustom) {
    const textoLimpo = String(mensagemCustom).trim();
    if (!textoLimpo) {
      throw new HttpsError("invalid-argument", "Escreva o texto do aviso.");
    }
    await aoVivoRef.set({
      proximaEtapa: textoLimpo,
      minutos: 0,
      disparadoEm: Date.now(),
      urgente: false,
      custom: true,
      avisoAntesMin: avisoAntesMin === 10 ? 10 : 5,
      avisoAntesEnviado: true
    });
    if (await notificacaoAtiva(equipeId, "aovivo")) await sendToAll(equipeId, "Aviso", textoLimpo, "publico.html?tab=aovivo");
    await registrarHistorico(equipeId, "custom", textoLimpo);
    return { ok: true };
  }
  if (!proximaEtapa || typeof minutos !== "number" || minutos < 0) {
    throw new HttpsError("invalid-argument", "Informe a próxima etapa e os minutos.");
  }
  const texto = urgente
    ? `🚨 Urgente — corram para ${proximaEtapa} agora!`
    : minutos === 0
      ? `Posicionem-se agora em ${proximaEtapa}`
      : `Em ${minutos} min: ${proximaEtapa}`;
  await aoVivoRef.set({
    proximaEtapa,
    minutos,
    disparadoEm: Date.now(),
    urgente: !!urgente,
    avisoAntesMin: avisoAntesMin === 10 ? 10 : 5,
    avisoAntesEnviado: false
  });
  if (await notificacaoAtiva(equipeId, "aovivo")) await sendToAll(equipeId, urgente ? "🚨 Urgente" : "Aviso ao vivo", texto, "publico.html?tab=aovivo");
  await registrarHistorico(equipeId, urgente ? "urgente" : "normal", texto);
  return { ok: true };
});

exports.avisoAntesFim = onSchedule("* * * * *", async () => {
  const equipeIds = await todasEquipeIds();
  for (const equipeId of equipeIds) {
    const ref = docRef(equipeId, "aoVivo", "atual");
    const snap = await ref.get();
    if (!snap.exists) continue;
    const a = snap.data();
    if (a.urgente || !a.minutos || a.avisoAntesEnviado) continue;
    const limiar = a.avisoAntesMin || 5;
    const restanteMin = (a.disparadoEm + a.minutos * 60000 - Date.now()) / 60000;
    if (restanteMin <= limiar && restanteMin > limiar - 1) {
      if (await notificacaoAtiva(equipeId, "aovivo")) await sendToAll(equipeId, "Atenção", `Faltam ${limiar} minutos — próxima etapa: ${a.proximaEtapa}`, "publico.html?tab=aovivo");
      await ref.update({ avisoAntesEnviado: true });
    }
  }
});

exports.limparAoVivoExpirado = onSchedule("* * * * *", async () => {
  const equipeIds = await todasEquipeIds();
  for (const equipeId of equipeIds) {
    const ref = docRef(equipeId, "aoVivo", "atual");
    const snap = await ref.get();
    if (!snap.exists) continue;
    const a = snap.data();
    const fimMs = (a.disparadoEm || 0) + (a.minutos || 0) * 60000;
    if (Date.now() - fimMs >= 5 * 60000) {
      await ref.delete();
    }
  }
});

const LIMIARES = [
  { chave: "24h", minutos: 24 * 60 },
  { chave: "3h", minutos: 3 * 60 },
  { chave: "30min", minutos: 30 }
];

const NOVA_EXPIRACAO_DIAS = 14;

exports.expirarMusicasNovas = onSchedule("every 24 hours", async () => {
  const equipeIds = await todasEquipeIds();
  const agora = Date.now();
  const limite = agora - NOVA_EXPIRACAO_DIAS * 24 * 60 * 60 * 1000;
  for (const equipeId of equipeIds) {
    const snap = await col(equipeId, "musicas").where("nova", "==", true).get();
    const semData = snap.docs.filter(d => !d.data().novaDesde);
    const expiradas = snap.docs.filter(d => d.data().novaDesde && d.data().novaDesde <= limite);
    await Promise.all([
      ...semData.map(d => d.ref.update({ novaDesde: agora })),
      ...expiradas.map(d => d.ref.update({ nova: false, novaDesde: FieldValue.delete() }))
    ]);
  }
});

const EXT_POR_TIPO = {
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a",
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/aac": "aac"
};

async function baixarDoDrive(fileId) {
  let url = `https://drive.google.com/uc?export=download&id=${fileId}`;
  let res = await fetch(url);
  let contentType = res.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    const html = await res.text();
    const match = html.match(/confirm=([0-9A-Za-z_]+)/);
    if (!match) throw new Error("Arquivo não acessível publicamente no Drive");
    url = `https://drive.google.com/uc?export=download&confirm=${match[1]}&id=${fileId}`;
    res = await fetch(url);
    contentType = res.headers.get("content-type") || "";
  }
  if (!res.ok) throw new Error(`Drive respondeu ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType: EXT_POR_TIPO[contentType] ? contentType : "audio/mpeg" };
}

exports.migrarAudiosDrive = onCall({ timeoutSeconds: 300 }, async request => {
  if (request.auth?.token?.email !== COORDENADOR_EMAIL) {
    throw new HttpsError("permission-denied", "Apenas o coordenador pode migrar áudios.");
  }
  const snap = await db.collection("musicas").get();
  const alvos = snap.docs.filter(d => d.data().audioId && !d.data().audioUrl);
  const bucket = getStorage().bucket();
  let migradas = 0;
  const falhas = [];
  for (const docSnap of alvos) {
    const m = docSnap.data();
    try {
      const { buffer, contentType } = await baixarDoDrive(m.audioId);
      const ext = EXT_POR_TIPO[contentType] || "mp3";
      const path = `audio/${docSnap.id}-${Date.now()}.${ext}`;
      const file = bucket.file(path);
      await file.save(buffer, { metadata: { contentType } });
      const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media`;
      await docSnap.ref.update({ audioUrl: url, audioId: FieldValue.delete() });
      migradas++;
    } catch (err) {
      falhas.push({ nome: m.nome || docSnap.id, erro: err.message });
    }
  }
  return { total: alvos.length, migradas, falhas };
});

const EXT_AUDIO_POR_CONTENT_TYPE = {
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a",
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/aac": "aac", "audio/webm": "webm"
};

exports.uploadAudioMusica = onCall({ timeoutSeconds: 120 }, async request => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Faça login para enviar o áudio.");
  }
  const { equipeId, musicaId, base64, contentType } = request.data || {};
  if (!musicaId || !base64) {
    throw new HttpsError("invalid-argument", "Selecione um arquivo de áudio válido.");
  }
  const email = request.auth.token.email;
  const autorizado = await isCoordenadorDaEquipe(email, equipeId || null);
  if (!autorizado) {
    throw new HttpsError("permission-denied", "Você não é coordenador desta equipe.");
  }
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length > 20 * 1024 * 1024) {
    throw new HttpsError("invalid-argument", "Áudio muito grande (máx. 20MB).");
  }
  const ext = EXT_AUDIO_POR_CONTENT_TYPE[contentType] || "mp3";
  const alvo = equipeId || "default";
  const path = `audio/${alvo}/${musicaId}-${Date.now()}.${ext}`;
  const bucket = getStorage().bucket();
  await bucket.file(path).save(buffer, { metadata: { contentType: contentType || "audio/mpeg" } });
  const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media`;
  return { url };
});

const EXT_POR_CONTENT_TYPE = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

exports.uploadHeaderImagem = onCall({ timeoutSeconds: 60 }, async request => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Faça login para trocar a imagem.");
  }
  const { equipeId, base64, contentType } = request.data || {};
  if (!base64 || !EXT_POR_CONTENT_TYPE[contentType]) {
    throw new HttpsError("invalid-argument", "Envie uma imagem válida (PNG, JPEG, WEBP ou GIF).");
  }
  const email = request.auth.token.email;
  const alvo = equipeId || "default";
  const autorizado = await isCoordenadorDaEquipe(email, equipeId || null);
  if (!autorizado) {
    throw new HttpsError("permission-denied", "Você não é coordenador desta equipe.");
  }
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length > 5 * 1024 * 1024) {
    throw new HttpsError("invalid-argument", "Imagem muito grande (máx. 5MB).");
  }
  const ext = EXT_POR_CONTENT_TYPE[contentType];
  const path = `headers/${alvo}/header-${Date.now()}.${ext}`;
  const bucket = getStorage().bucket();
  await bucket.file(path).save(buffer, { metadata: { contentType } });
  const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media`;
  return { url };
});

exports.lembretesAgenda = onSchedule("every 15 minutes", async () => {
  const equipeIds = await todasEquipeIds();
  const agora = Date.now();
  for (const equipeId of equipeIds) {
    if (!(await notificacaoAtiva(equipeId, "lembretes"))) continue;
    const snap = await col(equipeId, "agenda").get();
    for (const docSnap of snap.docs) {
      const a = docSnap.data();
      if (!a.data || !a.hora) continue;
      const evento = new Date(`${a.data}T${a.hora}:00-03:00`).getTime();
      const diffMin = (evento - agora) / 60000;
      const enviados = a.lembretesEnviados || [];
      for (const limiar of LIMIARES) {
        if (diffMin <= limiar.minutos && diffMin > limiar.minutos - 15 && !enviados.includes(limiar.chave)) {
          const faltaTexto = limiar.chave === "24h" ? "amanhã" : limiar.chave === "3h" ? "em 3 horas" : "em 30 minutos";
          await sendToAll(equipeId, "Lembrete", `${a.titulo || "Evento"} começa ${faltaTexto} (${a.hora})`);
          await docSnap.ref.update({ lembretesEnviados: [...enviados, limiar.chave] });
        }
      }
    }
  }
});

const SITE_BASE = "https://bandinha.k3d.app.br";

function escaparHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

exports.compartilharEquipe = onRequest(async (req, res) => {
  const equipeId = req.query.equipe || null;
  let titulo = "Bandinha";
  let descricao = "Músicas, coreografias, agenda e roteiro da Bandinha.";
  let imagem = `${SITE_BASE}/header.png`;
  let destino = `${SITE_BASE}/publico.html`;
  if (equipeId) {
    destino += `?equipe=${encodeURIComponent(equipeId)}`;
    try {
      const snap = await db.doc(`equipes/${equipeId}/config/main`).get();
      const cfg = snap.exists ? snap.data() : {};
      titulo = cfg.titulo || "Equipe";
      descricao = `Músicas, coreografias, agenda e roteiro da ${titulo}.`;
      if (cfg.headerUrl) imagem = cfg.headerUrl;
    } catch (err) {
      console.error(err);
    }
  }
  res.set("Cache-Control", "public, max-age=300");
  res.status(200).send(`<!DOCTYPE html>
<html lang="pt-BR"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escaparHtml(titulo)}</title>
<meta property="og:title" content="${escaparHtml(titulo)}">
<meta property="og:description" content="${escaparHtml(descricao)}">
<meta property="og:image" content="${escaparHtml(imagem)}">
<meta property="og:url" content="${escaparHtml(destino)}">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0;url=${escaparHtml(destino)}">
</head><body>
Redirecionando… <a href="${escaparHtml(destino)}">Toque aqui se não for redirecionado</a>
<script>location.replace(${JSON.stringify(destino)});</script>
</body></html>`);
});
