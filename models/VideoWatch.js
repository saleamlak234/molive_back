const mongoose = require("mongoose");

const videoWatchSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    video: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Video",
      required: true,
    },
    watchedAt: {
      type: Date,
      default: Date.now,
    },
    watchDate: {
      type: String, // YYYY-MM-DD format for daily tracking
      required: true,
    },
    completed: {
      type: Boolean,
      default: false,
    },
    rewardGiven: {
      type: Boolean,
      default: false,
    },
    watchDuration: {
      type: Number, // seconds watched
      default: 0,
    },
    fullWatch: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  },
);

// Compound index to prevent duplicate watches per user per video per day
videoWatchSchema.index({ user: 1, video: 1, watchDate: 1 }, { unique: true });

module.exports = mongoose.model("VideoWatch", videoWatchSchema);
