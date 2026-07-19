const mongoose = require("mongoose");

const commissionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    fromUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
    },
    amount: {
      type: Number,
      required: true,
    },
    level: {
      type: Number,
      required: true,
      min: 0,
      max: 3,
    },
    type: {
      type: String,
      enum: [
        "deposit",
        "upgrade",
        "earning",
        "dailyReturn",
        "dailyReferral",
        "directReferral",
        "credit",
      ],
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    // If commission was manually added by an admin
    isManual: {
      type: Boolean,
      default: false,
    },
    createdByAdmin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    sourceTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: "sourceModel",
    },
    sourceModel: {
      type: String,
      enum: ["Deposit", "MonthlyEarning", "CreditTransfer"],
    },
    // Track failure reasons for debugging
    failureReason: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("Commission", commissionSchema);
