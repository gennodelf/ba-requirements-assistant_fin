// Прод-сервер для Render: отдаёт собранный фронтенд (dist/) и обрабатывает /api/chat.
// Тот же обработчик, что и serverless-функция на Vercel — логику не дублируем.
// В отличие от serverless у обычного сервера нет лимита 60 сек — длинные документы доходят целиком.
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chatHandler from "./api/chat.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// API. Большой лимит тела — чтобы проходили вложения (PDF/картинки в base64).
app.post("/api/chat", express.json({ limit: "25mb" }), (req, res) => {
  chatHandler(req, res);
});

// Статика собранного фронтенда
const distDir = path.join(__dirname, "dist");
app.use(express.static(distDir));

// SPA-фолбэк: всё остальное отдаём index.html (Express 5 — через middleware, без '*')
app.use((req, res) => {
  res.sendFile(path.join(distDir, "index.html"));
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
