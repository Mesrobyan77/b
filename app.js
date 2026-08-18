require("dotenv").config();
const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");

const authRoutes = require("./routes/auth");
const conversationRoutes = require("./routes/conversations");
const User = require("./models/User");
const Message = require("./models/Message");
const Conversation = require("./models/Conversation");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:7779",
    methods: ["GET", "POST"],
  },
});

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err));

app.use("/api/auth", authRoutes);
app.use("/api/conversations", conversationRoutes);

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("Authentication required"));

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) return next(new Error("User not found"));

    socket.user = user;
    next();
  } catch (err) {
    next(new Error("Authentication failed"));
  }
});

const onlineUsers = new Map();

io.on("connection", async (socket) => {
  const userId = socket.user._id.toString();
  console.log(`User connected: ${socket.user.username} (${socket.id})`);

  if (!onlineUsers.has(userId)) {
    onlineUsers.set(userId, new Set());
  }
  onlineUsers.get(userId).add(socket.id);

  await User.findByIdAndUpdate(userId, { online: true });
  io.emit("user_online", { userId, online: true });

  const conversations = await Conversation.find({ participants: userId });
  conversations.forEach((conv) => {
    socket.join(conv._id.toString());
  });

  socket.on("send_message", async (data) => {
    try {
      const { conversationId, text, replyTo, media, mentions, ttl, topicId } = data;

      const conv = await Conversation.findById(conversationId);
      if (!conv) return socket.emit("error", { error: "Conversation not found" });

      const ROLE_HIERARCHY = { owner: 4, admin: 3, moderator: 2, member: 1 };

      if (conv.isGroup) {
        const member = conv.members.find((m) => m.user.toString() === userId);
        if (!member) return socket.emit("error", { error: "Not a member" });
        if (member.banned) return socket.emit("error", { error: "You are banned from this group" });
        if (member.muted) {
          if (!member.mutedUntil || new Date(member.mutedUntil) > new Date()) {
            return socket.emit("error", { error: "You are muted in this group" });
          }
        }

        const permLevel = conv.permissions?.["谁能发消息"] || "everyone";
        if (permLevel === "owner" && member.role !== "owner") {
          return socket.emit("error", { error: "Only owner can send messages" });
        }
        if (permLevel === "admins" && !["owner", "admin"].includes(member.role)) {
          return socket.emit("error", { error: "Only admins can send messages" });
        }

        if (media) {
          const mediaPerm = conv.permissions?.["谁能发媒体"] || "everyone";
          if (mediaPerm === "owner" && member.role !== "owner") {
            return socket.emit("error", { error: "Only owner can send media" });
          }
          if (mediaPerm === "admins" && !["owner", "admin"].includes(member.role)) {
            return socket.emit("error", { error: "Only admins can send media" });
          }
        }
      }

      const messageData = {
        conversation: conversationId,
        sender: userId,
        text: text || "",
        topicId: topicId || null,
      };
      if (replyTo) messageData.replyTo = replyTo;
      if (media) messageData.media = media;
      if (mentions && mentions.length > 0) messageData.mentions = mentions;
      if (ttl && ttl > 0) {
        messageData.ttl = ttl;
        messageData.expiresAt = new Date(Date.now() + ttl * 1000);
      }

      const message = await Message.create(messageData);

      await Conversation.findByIdAndUpdate(conversationId, {
        lastMessage: text || (media ? `[${media.type}]` : ""),
        lastMessageAt: new Date(),
      });

      const populated = await message.populate("sender", "-password");
      let replyData = null;
      if (replyTo) {
        replyData = await Message.findById(replyTo).populate("sender", "-password");
      }

      io.to(conversationId).emit("receive_message", {
        message: populated,
        conversationId,
        replyToMessage: replyData,
      });

      if (mentions && mentions.length > 0) {
        const isEveryone = mentions.includes("everyone");
        if (isEveryone && conv.isGroup) {
          conv.participants.forEach((participantId) => {
            if (participantId.toString() === userId) return;
            const userSockets = onlineUsers.get(participantId.toString());
            if (userSockets) {
              userSockets.forEach((sid) => {
                io.to(sid).emit("mention_notification", {
                  messageId: message._id,
                  conversationId,
                  senderName: socket.user.username,
                  text: text || "",
                  isEveryone: true,
                });
              });
            }
          });
        } else {
          mentions.forEach((mentionedUserId) => {
            if (mentionedUserId === "everyone") return;
            const userSockets = onlineUsers.get(mentionedUserId);
            if (userSockets) {
              userSockets.forEach((sid) => {
                io.to(sid).emit("mention_notification", {
                  messageId: message._id,
                  conversationId,
                  senderName: socket.user.username,
                  text: text || "",
                });
              });
            }
          });
        }
      }
    } catch (err) {
      socket.emit("error", { error: err.message });
    }
  });

  socket.on("edit_message", async (data) => {
    try {
      const { messageId, text } = data;
      const message = await Message.findById(messageId);
      if (!message || message.sender.toString() !== userId) return;

      message.text = text;
      message.edited = true;
      message.editedAt = new Date();
      await message.save();

      const populated = await message.populate("sender", "-password");
      io.to(message.conversation.toString()).emit("message_edited", {
        message: populated,
        conversationId: message.conversation.toString(),
      });
    } catch (err) {
      socket.emit("error", { error: err.message });
    }
  });

  socket.on("delete_message", async (data) => {
    try {
      const { messageId } = data;
      const message = await Message.findById(messageId);
      if (!message) return;

      if (message.sender.toString() !== userId) {
        const conv = await Conversation.findById(message.conversation);
        const member = conv?.members?.find((m) => m.user.toString() === userId);
        if (!member || !["owner", "admin"].includes(member.role)) {
          return socket.emit("error", { error: "Not authorized" });
        }
      }

      message.deleted = true;
      message.deletedAt = new Date();
      message.text = "";
      message.media = undefined;
      await message.save();

      io.to(message.conversation.toString()).emit("message_deleted", {
        messageId,
        conversationId: message.conversation.toString(),
      });
    } catch (err) {
      socket.emit("error", { error: err.message });
    }
  });

  socket.on("add_reaction", async (data) => {
    try {
      const { messageId, emoji } = data;
      const message = await Message.findById(messageId);
      if (!message) return;

      const existing = message.reactions.find(
        (r) => r.user.toString() === userId && r.emoji === emoji
      );

      if (existing) {
        message.reactions = message.reactions.filter(
          (r) => !(r.user.toString() === userId && r.emoji === emoji)
        );
      } else {
        message.reactions.push({ emoji, user: userId });
      }

      await message.save();

      io.to(message.conversation.toString()).emit("reaction_updated", {
        messageId,
        reactions: message.reactions,
        conversationId: message.conversation.toString(),
      });
    } catch (err) {
      socket.emit("error", { error: err.message });
    }
  });

  socket.on("pin_message", async (data) => {
    try {
      const { messageId } = data;
      const message = await Message.findById(messageId);
      if (!message) return;

      const conv = await Conversation.findById(message.conversation);
      if (!conv) return;

      if (conv.isGroup) {
        const member = conv.members.find((m) => m.user.toString() === userId);
        const permLevel = conv.permissions?.["谁能置顶消息"] || "admins";
        if (permLevel === "owner" && (!member || member.role !== "owner")) {
          return socket.emit("error", { error: "Only owner can pin messages" });
        }
        if (permLevel === "admins" && (!member || !["owner", "admin"].includes(member.role))) {
          return socket.emit("error", { error: "Only admins can pin messages" });
        }
      }

      message.pinned = !message.pinned;
      message.pinnedAt = message.pinned ? new Date() : null;
      await message.save();

      if (message.pinned) {
        conv.pinnedMessages.push(message._id);
      } else {
        conv.pinnedMessages = conv.pinnedMessages.filter(
          (id) => id.toString() !== message._id.toString()
        );
      }
      await conv.save();

      const populated = await message.populate("sender", "-password");
      io.to(message.conversation.toString()).emit("message_pinned", {
        message: populated,
        conversationId: message.conversation.toString(),
        pinned: message.pinned,
      });
    } catch (err) {
      socket.emit("error", { error: err.message });
    }
  });

  socket.on("mark_read", async (data) => {
    try {
      const { conversationId } = data;
      await Message.updateMany(
        {
          conversation: conversationId,
          sender: { $ne: userId },
          read: false,
        },
        { read: true }
      );
      io.to(conversationId).emit("messages_read", {
        conversationId,
        userId,
      });
    } catch (err) {
      socket.emit("error", { error: err.message });
    }
  });

  socket.on("typing", (data) => {
    const { conversationId } = data;
    socket.to(conversationId).emit("user_typing", {
      conversationId,
      userId,
      username: socket.user.username,
    });
  });

  socket.on("stop_typing", (data) => {
    const { conversationId } = data;
    socket.to(conversationId).emit("user_stop_typing", {
      conversationId,
      userId,
    });
  });

  socket.on("save_draft", async (data) => {
    try {
      const { conversationId, text } = data;
      const conv = await Conversation.findById(conversationId);
      if (conv) {
        conv.drafts.set(userId, text || "");
        await conv.save();
      }
    } catch (err) {
      socket.emit("error", { error: err.message });
    }
  });

  socket.on("call_user", (data) => {
    const { targetUserId, callerName, callType } = data;
    const targetSockets = onlineUsers.get(targetUserId);
    if (targetSockets) {
      targetSockets.forEach((socketId) => {
        io.to(socketId).emit("incoming_call", {
          callerId: userId,
          callerName,
          callType,
          socketId: socket.id,
        });
      });
    }
  });

  socket.on("accept_call", (data) => {
    const { callerSocketId, callType } = data;
    io.to(callerSocketId).emit("call_accepted", {
      callType,
      socketId: socket.id,
    });
  });

  socket.on("reject_call", (data) => {
    const { callerSocketId } = data;
    io.to(callerSocketId).emit("call_rejected");
  });

  socket.on("end_call", (data) => {
    const { targetSocketId } = data;
    io.to(targetSocketId).emit("call_ended");
  });

  socket.on("relay_ice", (data) => {
    io.to(data.targetSocketId).emit("ice_candidate", {
      candidate: data.candidate,
      senderSocketId: socket.id,
    });
  });

  socket.on("relay_offer", (data) => {
    io.to(data.targetSocketId).emit("call_offer", {
      offer: data.offer,
      senderSocketId: socket.id,
    });
  });

  socket.on("relay_answer", (data) => {
    io.to(data.targetSocketId).emit("call_answer", {
      answer: data.answer,
      senderSocketId: socket.id,
    });
  });

  socket.on("disconnect", async () => {
    console.log(`User disconnected: ${socket.user.username} (${socket.id})`);

    const sockets = onlineUsers.get(userId);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        onlineUsers.delete(userId);
        await User.findByIdAndUpdate(userId, {
          online: false,
          lastSeen: new Date(),
        });
        io.emit("user_online", { userId, online: false });
      }
    }
  });
});

const PORT = process.env.PORT || 7778;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
