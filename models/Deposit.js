const mongoose = require("mongoose");

const depositSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      validate: {
        validator: function (v) {
          if (this.package === "Credit Payment") return v > 0;
          return v >= 2500;
        },
        message: "Amount must be at least 2500 for regular packages.",
      },
    },
    totalAmount: {
      type: Number,
      required: true,
      default: 0,
    },
    package: {
      type: String,
      required: true,
      enum: [
        "1st Stock Package",
        "2nd Stock Package",
        "3rd Stock Package",
        "4th Stock Package",
        "5th Stock Package",
        "6th Stock Package",
        "7th Stock Package",
        "8th Stock Package",
        "Credit Payment",
      ],
    },
    paymentMethod: {
      type: String,
      required: true,
      enum: ["bank_transfer", "mobile_money"],
    },
    merchantAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MerchantAccount",
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "completed", "rejected"],
      default: "pending",
    },
    receiptUrl: {
      type: String,
      default: null,
    },
    transactionReference: {
      type: String,
      default: null,
      required: true,
    },
    rejectionReason: {
      type: String,
      default: null,
    },
    processedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    processedAt: {
      type: Date,
      default: null,
    },
    isUpgraded: {
      type: Boolean,
      default: false,
    },
    upgradedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Deposit",
      default: null,
    },
    upgradedFrom: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Deposit",
      default: null,
    },
    completedAt: { type: Date },
  },

  {
    timestamps: true,
  },
);

// Calculate monthly return based on package
depositSchema.methods.getMonthlyReturn = function () {
  const returnRates = {
    "8th Stock Package": 320000,
    "7th Stock Package": 160000,
    "6th Stock Package": 80000,
    "5th Stock Package": 40000,
    "4th Stock Package": 20000,
    "3rd Stock Package": 10000,
    "2nd Stock Package": 5000,
    "1st Stock Package": 2500,
  };
  return returnRates[this.package] || 0;
};

module.exports = mongoose.model("Deposit", depositSchema);
