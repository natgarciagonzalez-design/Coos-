// Servidor local de BookMind. Requiere Node.js 18 o superior.
// La clave de OpenAI se guarda en una variable de entorno, nunca en el navegador.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-6-astra';
const MAX_BODY = 1_000_000;

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          question: { type: 'string' },
          answer: { type: 'string' }
        },
        required: ['question', 'answer']
      }
    }
  },
  required: ['questions']
};

function send(res, status, data, type='application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new Error('La solicitud es demasiado grande.');
  }
  return JSON.parse(body || '{}');
}

async function generateQuestions(data) {
  if (!API_KEY) throw new Error('Falta configurar OPENAI_API_KEY en el servidor.');
  const title = String(data.title || 'Libro sin título').slice(0, 200);
  const author = String(data.author || '').slice(0, 200);
  const bookText = String(data.text || '').slice(0, 80000);
  const count = Math.min(15, Math.max(5, Number(data.count) || 12));
  if (bookText.trim().length < 200) throw new Error('El libro no contiene suficiente texto para generar preguntas.');

  const apiResponse = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      instructions: 'Eres un asistente educativo. Crea preguntas de comprensión y respuestas usando exclusivamente el contenido proporcionado del libro. No inventes datos ni agregues información externa. Distribuye las preguntas por distintas partes del texto, evita duplicados y combina preguntas sobre ideas principales, conceptos, hechos, personajes y relaciones cuando el contenido lo permita. Responde en español. Las respuestas deben ser claras y estar fundamentadas en el texto. Devuelve únicamente el objeto que cumple el esquema JSON solicitado.',
      input: `Libro: ${title}\nAutor: ${author}\n\nContenido del libro (fragmento disponible):\n${bookText}\n\nGenera ${count} preguntas variadas con sus respuestas. Si el texto no permite responder algo, no lo preguntes.`,
      text: {
        format: {
          type: 'json_schema',
          name: 'bookmind_questions',
          strict: true,
          schema
        }
      },
      max_output_tokens: 3500
    })
  });

  const result = await apiResponse.json().catch(() => ({}));
  if (!apiResponse.ok) {
    const message = result?.error?.message || `Error de la API (${apiResponse.status}).`;
    throw new Error(message);
  }
  const outputText = result.output_text || (result.output || [])
    .flatMap(item => item.content || [])
    .filter(item => item.type === 'output_text')
    .map(item => item.text).join('');
  if (!outputText) throw new Error('La IA no devolvió texto. Inténtalo nuevamente.');
  const parsed = JSON.parse(outputText);
  const questions = (parsed.questions || []).filter(q => q.question?.trim() && q.answer?.trim()).slice(0, 15);
  if (!questions.length) throw new Error('No se pudieron crear preguntas a partir de este contenido.');
  return { questions };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'POST' && url.pathname === '/api/generate-questions') {
      const data = await readBody(req);
      try {
        const result = await generateQuestions(data);
        return send(res, 200, result);
      } catch (error) {
        console.error('BookMind AI:', error.message);
        return send(res, 500, { error: error.message || 'Error al generar preguntas.' });
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Método no permitido.' });
    let requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const filePath = path.resolve(__dirname, '.' + requested);
    if (!filePath.startsWith(path.resolve(__dirname) + path.sep)) return send(res, 403, { error: 'Acceso denegado.' });
    const info = await stat(filePath);
    if (!info.isFile()) return send(res, 404, { error: 'No encontrado.' });
    const ext = path.extname(filePath).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    return res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) {
    if (error instanceof SyntaxError) return send(res, 400, { error: 'El cuerpo de la solicitud no es JSON válido.' });
    return send(res, 404, { error: 'No se pudo abrir el recurso solicitado.' });
  }
});

server.listen(PORT, () => {
  console.log(`BookMind está disponible en http://localhost:${PORT}`);
  if (!API_KEY) console.warn('Aviso: configura OPENAI_API_KEY para habilitar la generación real con IA.');
});
