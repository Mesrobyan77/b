const express = require("express");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const User = require("../models/User");
const auth = require("../middleware/auth");

const router = express.Router();

router.get("/", auth, async (req, res) => {
  try {
    const conversations = await Conversation.find({
      participants: req.user._id,
    })
      .populate("participants", "-password")
      .sort({ lastMessageAt: -1 });

    const result = await Promise.all(
      conversations.map(async (conv) => {
        const otherUser = conv.participants.find(
          (p) => p._id.toString() !== req.user._id.toString()
        );

        const unreadCount = await Message.countDocuments({
          conversation: conv._id,
          sender: { $ne: req.user._id },
          read: false,
          deleted: false,
        });

        const pinnedMessages = await Message.find({
          _id: { $in: conv.pinnedMessages || [] },
        }).populate("sender", "-password");

        return {
          _id: conv._id,
          name: conv.isGroup ? conv.name : otherUser?.username || "Unknown",
          avatar: otherUser?.avatar || otherUser?.username?.charAt(0) || "?",
          online: conv.isGroup ? false : otherUser?.online || false,
          lastMessage: conv.lastMessage,
          lastMessageAt: conv.lastMessageAt,
          unreadCount,
          isGroup: conv.isGroup,
          admin: conv.admin,
          members: conv.members,
          pinnedMessages,
          otherUser: conv.isGroup
            ? null
            : {
                _id: otherUser?._id,
                username: otherUser?.username,
                avatar: otherUser?.avatar,
                online: otherUser?.online,
              },
        };
      })
    );

    res.json({ conversations: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/", auth, async (req, res) => {
  try {
    const { userId } = req.body;

    const existing = await Conversation.findOne({
      participants: { $all: [req.user._id, userId], $size: 2 },
      isGroup: false,
    });

    if (existing) {
      return res.json({ conversation: existing });
    }

    const conversation = await Conversation.create({
      participants: [req.user._id, userId],
    });

    res.status(201).json({ conversation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/group", auth, async (req, res) => {
  try {
    const { name, memberIds } = req.body;

    if (!name || !memberIds || memberIds.length === 0) {
      return res.status(400).json({ error: "Name and members are required" });
    }

    const allMembers = [...new Set([req.user._id.toString(), ...memberIds])];

    const conversation = await Conversation.create({
      participants: allMembers,
      isGroup: true,
      name,
      admin: req.user._id,
      members: allMembers.map((id) => ({
        user: id,
        role: id === req.user._id.toString() ? "admin" : "member",
      })),
    });

    res.status(201).json({ conversation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/:id/name", auth, async (req, res) => {
  try {
    const { name } = req.body;
    const conv = await Conversation.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    if (!conv.isGroup) return res.status(400).json({ error: "Not a group" });
    if (conv.admin.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "Only admin can rename" });
    }
    conv.name = name;
    await conv.save();
    res.json({ conversation: conv });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/members", auth, async (req, res) => {
  try {
    const { userId } = req.body;
    const conv = await Conversation.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    if (!conv.isGroup) return res.status(400).json({ error: "Not a group" });

    if (!conv.members.some((m) => m.user.toString() === req.user._id.toString())) {
      return res.status(403).json({ error: "Not a member" });
    }

    if (conv.members.some((m) => m.user.toString() === userId)) {
      return res.status(400).json({ error: "Already a member" });
    }

    conv.members.push({ user: userId, role: "member" });
    conv.participants.push(userId);
    await conv.save();
    res.json({ conversation: conv });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:id/members/:userId", auth, async (req, res) => {
  try {
    const conv = await Conversation.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });

    const isAdmin = conv.admin.toString() === req.user._id.toString();
    const isSelf = req.params.userId === req.user._id.toString();

    if (!isAdmin && !isSelf) {
      return res.status(403).json({ error: "Not authorized" });
    }

    conv.members = conv.members.filter((m) => m.user.toString() !== req.params.userId);
    conv.participants = conv.participants.filter((p) => p.toString() !== req.params.userId);
    await conv.save();
    res.json({ conversation: conv });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/:id/messages", auth, async (req, res) => {
  try {
    const { search } = req.query;
    const query = { conversation: req.params.id, deleted: false };

    if (search) {
      query.text = { $regex: search, $options: "i" };
    }

    const messages = await Message.find(query)
      .populate("sender", "-password")
      .populate("replyTo")
      .sort({ createdAt: 1 });

    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/messages", auth, async (req, res) => {
  try {
    const { text } = req.body;

    const message = await Message.create({
      conversation: req.params.id,
      sender: req.user._id,
      text,
    });

    await Conversation.findByIdAndUpdate(req.params.id, {
      lastMessage: text,
      lastMessageAt: new Date(),
    });

    const populated = await message.populate("sender", "-password");

    res.status(201).json({ message: populated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/messages/:messageId", auth, async (req, res) => {
  try {
    const { text } = req.body;
    const message = await Message.findById(req.params.messageId);
    if (!message) return res.status(404).json({ error: "Message not found" });
    if (message.sender.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "Not authorized" });
    }
    message.text = text;
    message.edited = true;
    message.editedAt = new Date();
    await message.save();
    const populated = await message.populate("sender", "-password");
    res.json({ message: populated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/messages/:messageId", auth, async (req, res) => {
  try {
    const message = await Message.findById(req.params.messageId);
    if (!message) return res.status(404).json({ error: "Message not found" });
    if (message.sender.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "Not authorized" });
    }
    message.deleted = true;
    message.deletedAt = new Date();
    message.text = "";
    message.media = undefined;
    await message.save();
    const populated = await message.populate("sender", "-password");
    res.json({ message: populated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/messages/:messageId/react", auth, async (req, res) => {
  try {
    const { emoji } = req.body;
    const message = await Message.findById(req.params.messageId);
    if (!message) return res.status(404).json({ error: "Message not found" });

    const existing = message.reactions.find(
      (r) => r.user.toString() === req.user._id.toString() && r.emoji === emoji
    );

    if (existing) {
      message.reactions = message.reactions.filter(
        (r) => !(r.user.toString() === req.user._id.toString() && r.emoji === emoji)
      );
    } else {
      message.reactions.push({ emoji, user: req.user._id });
    }

    await message.save();
    const populated = await message.populate("sender", "-password");
    res.json({ message: populated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/messages/:messageId/pin", auth, async (req, res) => {
  try {
    const message = await Message.findById(req.params.messageId);
    if (!message) return res.status(404).json({ error: "Message not found" });

    const conv = await Conversation.findById(message.conversation);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });

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
    res.json({ message: populated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/search", auth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json({ messages: [] });

    const conversations = await Conversation.find({
      participants: req.user._id,
    });

    const convIds = conversations.map((c) => c._id);

    const messages = await Message.find({
      conversation: { $in: convIds },
      text: { $regex: q, $options: "i" },
      deleted: false,
    })
      .populate("sender", "-password")
      .populate("conversation")
      .sort({ createdAt: -1 })
      .limit(50);

    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/draft", auth, async (req, res) => {
  try {
    const { text } = req.body;
    const conv = await Conversation.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    conv.drafts.set(req.user._id.toString(), text || "");
    await conv.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
