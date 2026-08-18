const express = require("express");
const crypto = require("crypto");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const User = require("../models/User");
const auth = require("../middleware/auth");

const router = express.Router();

const ROLE_HIERARCHY = { owner: 4, admin: 3, moderator: 2, member: 1 };

function hasPermission(conv, userId, action) {
  if (!conv.isGroup) return true;
  const member = conv.members.find((m) => m.user.toString() === userId.toString());
  if (!member || member.banned) return false;
  const permLevel = conv.permissions?.[action] || "everyone";
  if (permLevel === "everyone") return true;
  if (permLevel === "owner") return member.role === "owner";
  if (permLevel === "admins") return ["owner", "admin"].includes(member.role);
  return true;
}

function isMuted(member) {
  if (!member.muted) return false;
  if (member.mutedUntil && new Date(member.mutedUntil) < new Date()) return false;
  return true;
}

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
          avatar: conv.avatar || otherUser?.avatar || otherUser?.username?.charAt(0) || "?",
          description: conv.description || "",
          online: conv.isGroup ? false : otherUser?.online || false,
          lastMessage: conv.lastMessage,
          lastMessageAt: conv.lastMessageAt,
          unreadCount,
          isGroup: conv.isGroup,
          admin: conv.admin,
          members: conv.members,
          permissions: conv.permissions,
          topics: conv.topics,
          welcomeMessage: conv.welcomeMessage,
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
    const { name, memberIds, description, welcomeMessage } = req.body;

    if (!name || !memberIds || memberIds.length === 0) {
      return res.status(400).json({ error: "Name and members are required" });
    }

    const allMembers = [...new Set([req.user._id.toString(), ...memberIds])];

    const conversation = await Conversation.create({
      participants: allMembers,
      isGroup: true,
      name,
      description: description || "",
      welcomeMessage: welcomeMessage || "",
      admin: req.user._id,
      members: allMembers.map((id) => ({
        user: id,
        role: id === req.user._id.toString() ? "owner" : "member",
      })),
      topics: [{ name: "General", description: "General discussion", createdBy: req.user._id }],
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

    const member = conv.members.find((m) => m.user.toString() === req.user._id.toString());
    if (!member || !["owner", "admin"].includes(member.role)) {
      return res.status(403).json({ error: "Not authorized" });
    }

    conv.name = name;
    await conv.save();
    res.json({ conversation: conv });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/:id/description", auth, async (req, res) => {
  try {
    const { description } = req.body;
    const conv = await Conversation.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    if (!conv.isGroup) return res.status(400).json({ error: "Not a group" });

    if (!hasPermission(conv, req.user._id, "谁能编辑群信息")) {
      return res.status(403).json({ error: "Not authorized" });
    }

    conv.description = description;
    await conv.save();
    res.json({ conversation: conv });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/:id/welcome-message", auth, async (req, res) => {
  try {
    const { welcomeMessage } = req.body;
    const conv = await Conversation.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    if (!conv.isGroup) return res.status(400).json({ error: "Not a group" });

    if (!hasPermission(conv, req.user._id, "谁能编辑群信息")) {
      return res.status(403).json({ error: "Not authorized" });
    }

    conv.welcomeMessage = welcomeMessage;
    await conv.save();
    res.json({ conversation: conv });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/:id/permissions", auth, async (req, res) => {
  try {
    const { permissions } = req.body;
    const conv = await Conversation.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    if (!conv.isGroup) return res.status(400).json({ error: "Not a group" });

    const member = conv.members.find((m) => m.user.toString() === req.user._id.toString());
    if (!member || member.role !== "owner") {
      return res.status(403).json({ error: "Only owner can change permissions" });
    }

    conv.permissions = { ...conv.permissions, ...permissions };
    await conv.save();
    res.json({ conversation: conv });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/:id/members/:userId/role", auth, async (req, res) => {
  try {
    const { role } = req.body;
    const conv = await Conversation.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    if (!conv.isGroup) return res.status(400).json({ error: "Not a group" });

    const requester = conv.members.find((m) => m.user.toString() === req.user._id.toString());
    if (!requester || requester.role !== "owner") {
      return res.status(403).json({ error: "Only owner can change roles" });
    }

    const targetMember = conv.members.find((m) => m.user.toString() === req.params.userId);
    if (!targetMember) return res.status(404).json({ error: "Member not found" });
    if (targetMember.role === "owner") return res.status(400).json({ error: "Cannot change owner role" });

    targetMember.role = role;
    await conv.save();

    const populated = await conv.populate("members.user", "-password");
    res.json({ conversation: populated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/:id/members/:userId/mute", auth, async (req, res) => {
  try {
    const { muted, duration } = req.body;
    const conv = await Conversation.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    if (!conv.isGroup) return res.status(400).json({ error: "Not a group" });

    const requester = conv.members.find((m) => m.user.toString() === req.user._id.toString());
    if (!requester || !["owner", "admin", "moderator"].includes(requester.role)) {
      return res.status(403).json({ error: "Not authorized" });
    }

    const targetMember = conv.members.find((m) => m.user.toString() === req.params.userId);
    if (!targetMember) return res.status(404).json({ error: "Member not found" });
    if (targetMember.role === "owner") return res.status(400).json({ error: "Cannot mute owner" });

    targetMember.muted = muted;
    targetMember.mutedUntil = muted && duration ? new Date(Date.now() + duration * 1000) : null;
    await conv.save();

    const populated = await conv.populate("members.user", "-password");
    res.json({ conversation: populated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/:id/members/:userId/ban", auth, async (req, res) => {
  try {
    const { banned } = req.body;
    const conv = await Conversation.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    if (!conv.isGroup) return res.status(400).json({ error: "Not a group" });

    const requester = conv.members.find((m) => m.user.toString() === req.user._id.toString());
    if (!requester || !["owner", "admin"].includes(requester.role)) {
      return res.status(403).json({ error: "Not authorized" });
    }

    const targetMember = conv.members.find((m) => m.user.toString() === req.params.userId);
    if (!targetMember) return res.status(404).json({ error: "Member not found" });
    if (targetMember.role === "owner") return res.status(400).json({ error: "Cannot ban owner" });

    targetMember.banned = banned;
    targetMember.bannedAt = banned ? new Date() : null;
    if (banned) {
      targetMember.muted = false;
      targetMember.mutedUntil = null;
    }
    await conv.save();

    const populated = await conv.populate("members.user", "-password");
    res.json({ conversation: populated });
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

    if (!hasPermission(conv, req.user._id, "谁能邀请成员")) {
      return res.status(403).json({ error: "Not authorized to invite members" });
    }

    if (conv.members.some((m) => m.user.toString() === userId)) {
      return res.status(400).json({ error: "Already a member" });
    }

    conv.members.push({ user: userId, role: "member" });
    conv.participants.push(userId);
    await conv.save();

    if (conv.welcomeMessage) {
      const systemMsg = await Message.create({
        conversation: conv._id,
        sender: req.user._id,
        text: conv.welcomeMessage.replace("{user}", (await User.findById(userId))?.username || "someone"),
        type: "welcome",
      });
      io.to(conv._id.toString()).emit("receive_message", {
        message: await systemMsg.populate("sender", "-password"),
        conversationId: conv._id.toString(),
      });
    }

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

router.post("/:id/invite-link", auth, async (req, res) => {
  try {
    const { maxUses, expiresIn } = req.body;
    const conv = await Conversation.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    if (!conv.isGroup) return res.status(400).json({ error: "Not a group" });

    if (!hasPermission(conv, req.user._id, "谁能邀请成员")) {
      return res.status(403).json({ error: "Not authorized" });
    }

    const code = crypto.randomBytes(8).toString("hex");
    const link = {
      code,
      createdBy: req.user._id,
      maxUses: maxUses || 0,
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
    };

    conv.inviteLinks.push(link);
    await conv.save();

    res.json({ inviteLink: { code, maxUses: link.maxUses, expiresAt: link.expiresAt } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/join/:code", auth, async (req, res) => {
  try {
    const conv = await Conversation.findOne({
      "inviteLinks.code": req.params.code,
      "inviteLinks.active": true,
    });

    if (!conv) return res.status(404).json({ error: "Invalid invite link" });

    const link = conv.inviteLinks.find((l) => l.code === req.params.code);
    if (!link) return res.status(404).json({ error: "Invalid invite link" });

    if (link.expiresAt && new Date(link.expiresAt) < new Date()) {
      return res.status(400).json({ error: "Invite link expired" });
    }
    if (link.maxUses > 0 && link.uses >= link.maxUses) {
      return res.status(400).json({ error: "Invite link max uses reached" });
    }

    if (conv.members.some((m) => m.user.toString() === req.user._id.toString())) {
      return res.json({ conversation: conv });
    }

    conv.members.push({ user: req.user._id, role: "member" });
    conv.participants.push(req.user._id);
    link.uses += 1;
    await conv.save();

    if (conv.welcomeMessage) {
      const systemMsg = await Message.create({
        conversation: conv._id,
        sender: req.user._id,
        text: conv.welcomeMessage.replace("{user}", req.user.username),
        type: "welcome",
      });
      io.to(conv._id.toString()).emit("receive_message", {
        message: await systemMsg.populate("sender", "-password"),
        conversationId: conv._id.toString(),
      });
    }

    res.json({ conversation: conv });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/topics", auth, async (req, res) => {
  try {
    const { name, description } = req.body;
    const conv = await Conversation.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    if (!conv.isGroup) return res.status(400).json({ error: "Not a group" });

    if (!hasPermission(conv, req.user._id, "谁能编辑群信息")) {
      return res.status(403).json({ error: "Not authorized" });
    }

    conv.topics.push({ name, description: description || "", createdBy: req.user._id });
    await conv.save();

    res.json({ topics: conv.topics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:id/topics/:topicId", auth, async (req, res) => {
  try {
    const conv = await Conversation.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });

    if (!hasPermission(conv, req.user._id, "谁能编辑群信息")) {
      return res.status(403).json({ error: "Not authorized" });
    }

    conv.topics = conv.topics.filter((t) => t._id.toString() !== req.params.topicId);
    await conv.save();

    res.json({ topics: conv.topics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/polls", auth, async (req, res) => {
  try {
    const { question, options } = req.body;
    const conv = await Conversation.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    if (!conv.isGroup) return res.status(400).json({ error: "Not a group" });

    if (!hasPermission(conv, req.user._id, "谁能创建投票")) {
      return res.status(403).json({ error: "Not authorized" });
    }

    if (!question || !options || options.length < 2) {
      return res.status(400).json({ error: "Question and at least 2 options required" });
    }

    const poll = {
      question,
      options: options.map((text) => ({ text, votes: [] })),
      createdBy: req.user._id,
    };

    conv.polls.push(poll);
    await conv.save();

    const createdPoll = conv.polls[conv.polls.length - 1];

    const systemMsg = await Message.create({
      conversation: conv._id,
      sender: req.user._id,
      text: `📊 Poll: ${question}`,
      type: "poll",
      media: { type: "file", url: JSON.stringify({ pollId: createdPoll._id, conversationId: conv._id }), name: "poll", size: 0, duration: 0, thumbnail: "" },
    });

    const populated = await systemMsg.populate("sender", "-password");
    io.to(conv._id.toString()).emit("receive_message", {
      message: populated,
      conversationId: conv._id.toString(),
    });

    res.json({ poll: createdPoll });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/polls/:pollId/vote", auth, async (req, res) => {
  try {
    const { optionId } = req.body;
    const conv = await Conversation.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });

    const poll = conv.polls.id(req.params.pollId);
    if (!poll) return res.status(404).json({ error: "Poll not found" });
    if (poll.closed) return res.status(400).json({ error: "Poll is closed" });

    poll.options.forEach((opt) => {
      opt.votes = opt.votes.filter((v) => v.toString() !== req.user._id.toString());
    });

    const selectedOption = poll.options.id(optionId);
    if (!selectedOption) return res.status(404).json({ error: "Option not found" });

    selectedOption.votes.push(req.user._id);
    await conv.save();

    io.to(conv._id.toString()).emit("poll_updated", {
      poll,
      conversationId: conv._id.toString(),
    });

    res.json({ poll });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/polls/:pollId/close", auth, async (req, res) => {
  try {
    const conv = await Conversation.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });

    const poll = conv.polls.id(req.params.pollId);
    if (!poll) return res.status(404).json({ error: "Poll not found" });

    if (poll.createdBy.toString() !== req.user._id.toString()) {
      const member = conv.members.find((m) => m.user.toString() === req.user._id.toString());
      if (!member || !["owner", "admin"].includes(member.role)) {
        return res.status(403).json({ error: "Not authorized" });
      }
    }

    poll.closed = true;
    await conv.save();

    io.to(conv._id.toString()).emit("poll_updated", {
      poll,
      conversationId: conv._id.toString(),
    });

    res.json({ poll });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/:id/messages", auth, async (req, res) => {
  try {
    const { search, topicId } = req.query;
    const query = { conversation: req.params.id, deleted: false };

    if (search) {
      query.text = { $regex: search, $options: "i" };
    }

    if (topicId) {
      query.topicId = topicId === "general" ? null : topicId;
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

    const conv = await Conversation.findById(message.conversation);
    const member = conv?.members?.find((m) => m.user.toString() === req.user._id.toString());
    const isOwner = member?.role === "owner";
    const isAdmin = member?.role === "admin";

    if (message.sender.toString() !== req.user._id.toString() && !isOwner && !isAdmin) {
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

    if (!hasPermission(conv, req.user._id, "谁能置顶消息")) {
      return res.status(403).json({ error: "Not authorized to pin messages" });
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
