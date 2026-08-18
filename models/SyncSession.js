const mongoose = require("mongoose");

const syncQueueItemSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    videoId: { type: String, required: true },
    title: { type: String, default: "" },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { _id: true, timestamps: true }
);

const syncChatMessageSchema = new mongoose.Schema(
  {
    sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    text: { type: String, required: true, trim: true },
  },
  { _id: true, timestamps: true }
);

const syncSessionSchema = new mongoose.Schema(
  {
    conversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
    },
    videoUrl: { type: String, required: true },
    videoId: { type: String, required: true },
    title: { type: String, default: "" },
    isPlaying: { type: Boolean, default: false },
    currentTime: { type: Number, default: 0 },
    startedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    queue: [syncQueueItemSchema],
    chat: [syncChatMessageSchema],
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

syncSessionSchema.index({ conversation: 1, active: 1 });

module.exports = mongoose.model("SyncSession", syncSessionSchema);
