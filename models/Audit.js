const mongoose = require("mongoose");

const auditSchema = new mongoose.Schema(
  {
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    fieldChanged: {
      type: String,
      enum: ["balance", "totalCommissions", "totalDeposits", "other"],
      required: true,
    },
    oldValue: {
      type: Number,
      required: true,
    },
    newValue: {
      type: Number,
      required: true,
    },
    action: {
      type: String,
      enum: ["set", "add", "subtract"],
      default: "set",
    },
    reason: {
      type: String,
      required: true,
    },
    description: String,
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Audit", auditSchema);
