const mongoose = require("mongoose");

const vipBonusSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    vipLevel: {
      type: Number,
      required: true,
      min: 1,
      max: 6,
    },
    bonusType: {
      type: String,
      enum: ["vip_monthly"],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    month: {
      type: Number,
      required: true,
      min: 1,
      max: 12,
    },
    year: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "paid"],
      default: "pending",
    },
    description: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

// Compound index to prevent duplicate bonuses
vipBonusSchema.index(
  { user: 1, bonusType: 1, month: 1, year: 1 },
  { unique: true },
);

module.exports = mongoose.model("VipBonus", vipBonusSchema);
