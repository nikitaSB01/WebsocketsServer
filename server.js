import { randomUUID } from "node:crypto";
import http from "node:http";
import bodyParser from "body-parser";
import cors from "cors";
import express from "express";
import pino from "pino";
import pinoPretty from "pino-pretty";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
const logger = pino(pinoPretty());

app.use(cors());
app.use(
  bodyParser.json({
    type(req) {
      return true;
    },
  })
);
app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json");
  next();
});

const userState = [];
const messageHistory = []; // Массив для хранения истории сообщений
const lastActiveTimes = {}; // Хранение времени последней активности пользователей

app.post("/new-user", async (request, response) => {
  if (Object.keys(request.body).length === 0) {
    const result = {
      status: "error",
      message: "This name is already taken!",
    };
    response.status(400).send(JSON.stringify(result)).end();
    return;
  }

  const { name } = request.body;
  const isExist = userState.find((user) => user.name === name);

  if (!isExist) {
    const newUser = {
      id: randomUUID(),
      name: name,
    };
    userState.push(newUser);

    const result = {
      status: "ok",
      user: newUser,
    };
    logger.info(`New user created: ${JSON.stringify(newUser)}`);
    response.send(JSON.stringify(result)).end();
  } else {
    const result = {
      status: "error",
      message: "This name is already taken!",
    };
    logger.error(`User with name "${name}" already exists`);
    response.status(409).send(JSON.stringify(result)).end();
  }
});

const server = http.createServer(app);
const wsServer = new WebSocketServer({ server });

wsServer.on("connection", (ws) => {
  // Отправляем историю сообщений новому пользователю
  ws.send(JSON.stringify({ type: "history", data: messageHistory }));

  ws.on("message", (msg, isBinary) => {
    const receivedMSG = JSON.parse(msg);
    logger.info(`Message received: ${JSON.stringify(receivedMSG)}`);

    // Обработка пинг-сообщений для обновления времени активности пользователя
    if (receivedMSG.type === "ping") {
      lastActiveTimes[receivedMSG.user.name] = Date.now();
      return;
    }

    // Обработка события присоединения нового пользователя
    if (receivedMSG.type === "join") {
      const { name } = receivedMSG.user;
      const isExist = userState.find((user) => user.name === name);

      if (!isExist) {
        userState.push(receivedMSG.user);
        lastActiveTimes[name] = Date.now(); // Устанавливаем время активности
      }

      // Отправляем обновленный список всем клиентам
      [...wsServer.clients]
        .filter((o) => o.readyState === WebSocket.OPEN)
        .forEach((o) => o.send(JSON.stringify(userState)));
    }

    // Обработка выхода пользователя
    if (receivedMSG.type === "exit") {
      const idx = userState.findIndex(
        (user) => user.name === receivedMSG.user.name
      );

      if (idx !== -1) {
        userState.splice(idx, 1);
        delete lastActiveTimes[receivedMSG.user.name];
      }

      [...wsServer.clients]
        .filter((o) => o.readyState === WebSocket.OPEN)
        .forEach((o) => o.send(JSON.stringify(userState)));

      logger.info(`User with name "${receivedMSG.user.name}" has been deleted`);
      return;
    }

    // Обработка отправки сообщения
    if (receivedMSG.type === "send") {
      // Сохраняем сообщение в истории
      messageHistory.push(receivedMSG);

      // Отправляем сообщение всем подключенным клиентам
      [...wsServer.clients]
        .filter((o) => o.readyState === WebSocket.OPEN)
        .forEach((o) => o.send(msg, { binary: isBinary }));

      logger.info("Message sent to all users");
    }

    // Обработка запроса на очистку истории
    if (receivedMSG.type === "clear") {
      messageHistory.length = 0; // Очистка истории
      [...wsServer.clients]
        .filter((o) => o.readyState === WebSocket.OPEN)
        .forEach((o) => o.send(JSON.stringify({ type: "history", data: [] })));
      logger.info("Chat history cleared");
    }
  });

  // Удаление пользователя при отключении (разрыв WebSocket-соединения)
  ws.on("close", () => {
    const userIndex = userState.findIndex((user) => user.ws === ws);

    if (userIndex !== -1) {
      const disconnectedUser = userState[userIndex];
      userState.splice(userIndex, 1);
      delete lastActiveTimes[disconnectedUser.name];

      // Отправляем обновленный список пользователей всем клиентам
      [...wsServer.clients]
        .filter((o) => o.readyState === WebSocket.OPEN)
        .forEach((o) => o.send(JSON.stringify(userState)));

      logger.info(`User with name "${disconnectedUser.name}" has disconnected`);
    }
  });

  // Проверка активности пользователей каждые 30 секунд
  setInterval(() => {
    const currentTime = Date.now();
    userState.forEach((user, index) => {
      if (
        lastActiveTimes[user.name] &&
        currentTime - lastActiveTimes[user.name] > 5000
      ) {
        userState.splice(index, 1);
        delete lastActiveTimes[user.name];
        broadcastUserState();
      }
    });
  }, 5000);

  function broadcastUserState() {
    wsServer.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(userState));
      }
    });
  }
});

const port = process.env.PORT || 3000;

const bootstrap = async () => {
  try {
    server.listen(port, () =>
      logger.info(`Server has been started on http://localhost:${port}`)
    );
  } catch (error) {
    logger.error(`Error: ${error.message}`);
  }
};

bootstrap();
