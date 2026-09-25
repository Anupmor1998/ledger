const prisma = require("../config/prisma");
const AppError = require("../utils/appError");
const logger = require("../utils/logger");
const {
  sendSupportTicketAdminAlert,
  sendSupportTicketStatusUpdateToUser,
} = require("../utils/email");

const VALID_CATEGORIES = [
  "BILLING_PAYMENT",
  "ORDER_ISSUE",
  "TECHNICAL_GLITCH",
  "ACCOUNT_PROFILE",
  "OTHER",
];

const VALID_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"];

const VALID_STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"];

// In-memory set of active SSE admin client response streams
const sseAdminClients = new Set();

/**
 * Broadcast current support ticket metrics to all connected admin SSE clients
 */
async function broadcastSupportStats() {
  if (sseAdminClients.size === 0) return;

  try {
    const [total, open, inProgress, resolved, urgentOpen] = await Promise.all([
      prisma.supportTicket.count(),
      prisma.supportTicket.count({ where: { status: "OPEN" } }),
      prisma.supportTicket.count({ where: { status: "IN_PROGRESS" } }),
      prisma.supportTicket.count({ where: { status: "RESOLVED" } }),
      prisma.supportTicket.count({
        where: {
          status: "OPEN",
          priority: "URGENT",
        },
      }),
    ]);

    const payload = JSON.stringify({
      type: "STATS_UPDATE",
      stats: {
        total,
        open,
        inProgress,
        resolved,
        urgentOpen,
      },
    });

    for (const clientRes of sseAdminClients) {
      try {
        clientRes.write(`data: ${payload}\n\n`);
      } catch (_err) {
        sseAdminClients.delete(clientRes);
      }
    }
  } catch (err) {
    logger.error("Failed to broadcast support stats to admin SSE clients", {
      error: err,
    });
  }
}

/**
 * Admin: Server-Sent Events (SSE) live connection for instant badge updates
 */
async function streamAdminSupportLive(req, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  sseAdminClients.add(res);

  // Send current stats immediately upon connecting
  try {
    const [total, open, inProgress, resolved, urgentOpen] = await Promise.all([
      prisma.supportTicket.count(),
      prisma.supportTicket.count({ where: { status: "OPEN" } }),
      prisma.supportTicket.count({ where: { status: "IN_PROGRESS" } }),
      prisma.supportTicket.count({ where: { status: "RESOLVED" } }),
      prisma.supportTicket.count({
        where: {
          status: "OPEN",
          priority: "URGENT",
        },
      }),
    ]);

    res.write(
      `data: ${JSON.stringify({
        type: "STATS_UPDATE",
        stats: { total, open, inProgress, resolved, urgentOpen },
      })}\n\n`,
    );
  } catch (_e) {
    // ignore
  }

  // Send keep-alive heartbeat every 20 seconds to prevent network idle timeout
  const heartbeat = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch (_e) {
      clearInterval(heartbeat);
      sseAdminClients.delete(res);
    }
  }, 20000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseAdminClients.delete(res);
  });
}

/**
 * User: Create a new support ticket
 */
async function createTicket(req, res, next) {
  try {
    const {
      subject,
      category = "OTHER",
      priority = "MEDIUM",
      description,
      contactPhone,
      contactPreference = "WHATSAPP",
    } = req.body;

    if (!subject || !subject.trim()) {
      return next(new AppError("Subject is required", 400));
    }

    if (!description || !description.trim()) {
      return next(new AppError("Description is required", 400));
    }

    const safeCategory = VALID_CATEGORIES.includes(category)
      ? category
      : "OTHER";
    const safePriority = VALID_PRIORITIES.includes(priority)
      ? priority
      : "MEDIUM";

    const ticket = await prisma.supportTicket.create({
      data: {
        userId: req.user.userId,
        subject: subject.trim(),
        category: safeCategory,
        priority: safePriority,
        description: description.trim(),
        contactPhone: contactPhone ? String(contactPhone).trim() : null,
        contactPreference: String(
          contactPreference || "WHATSAPP",
        ).toUpperCase(),
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    // Broadcast updated stats to all connected admin screens in real-time
    broadcastSupportStats();

    // Alert all admins asynchronously via email
    (async () => {
      try {
        const admins = await prisma.user.findMany({
          where: { role: "ADMIN" },
          select: { email: true, name: true },
        });

        const adminEmails = admins.map((a) => a.email).filter(Boolean);
        if (adminEmails.length > 0) {
          await sendSupportTicketAdminAlert({
            ticket,
            user: ticket.user || req.user,
            adminEmails,
          });
        }
      } catch (err) {
        logger.error("Failed to notify admins of new ticket", {
          ticketId: ticket.id,
          ticketNo: ticket.ticketNo,
          error: err,
        });
      }
    })();

    res.status(201).json({
      success: true,
      ticket,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * User: Get tickets raised by the current user
 */
async function getMyTickets(req, res, next) {
  try {
    const tickets = await prisma.supportTicket.findMany({
      where: { userId: req.user.userId },
      orderBy: { createdAt: "desc" },
      include: {
        resolvedByAdmin: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    res.json({
      success: true,
      tickets,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Common: Get single ticket details
 */
async function getTicketById(req, res, next) {
  try {
    const { id } = req.params;
    const ticket = await prisma.supportTicket.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        resolvedByAdmin: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!ticket) {
      return next(new AppError("Support ticket not found", 404));
    }

    if (req.user.role !== "ADMIN" && ticket.userId !== req.user.userId) {
      return next(new AppError("You do not have access to this ticket", 403));
    }

    res.json({
      success: true,
      ticket,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Admin: List all tickets across all users with filtering & search
 */
async function listAllTickets(req, res, next) {
  try {
    const {
      status,
      priority,
      category,
      search,
      page = 1,
      limit = 50,
    } = req.query;

    const where = {};

    if (status && VALID_STATUSES.includes(status)) {
      where.status = status;
    }

    if (priority && VALID_PRIORITIES.includes(priority)) {
      where.priority = priority;
    }

    if (category && VALID_CATEGORIES.includes(category)) {
      where.category = category;
    }

    if (search && search.trim()) {
      const q = search.trim();
      const ticketNoMatch = parseInt(q, 10);
      where.OR = [
        { subject: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
        { contactPhone: { contains: q, mode: "insensitive" } },
        { user: { name: { contains: q, mode: "insensitive" } } },
        { user: { email: { contains: q, mode: "insensitive" } } },
      ];
      if (!Number.isNaN(ticketNoMatch)) {
        where.OR.push({ ticketNo: ticketNoMatch });
      }
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    const [total, tickets] = await Promise.all([
      prisma.supportTicket.count({ where }),
      prisma.supportTicket.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: [{ createdAt: "desc" }],
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          resolvedByAdmin: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      }),
    ]);

    res.json({
      success: true,
      tickets,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Admin: Get ticket summary stats (for sidebar badge & stats summary)
 */
async function getSupportStats(req, res, next) {
  try {
    const [total, open, inProgress, resolved, urgentOpen] = await Promise.all([
      prisma.supportTicket.count(),
      prisma.supportTicket.count({ where: { status: "OPEN" } }),
      prisma.supportTicket.count({ where: { status: "IN_PROGRESS" } }),
      prisma.supportTicket.count({ where: { status: "RESOLVED" } }),
      prisma.supportTicket.count({
        where: {
          status: "OPEN",
          priority: "URGENT",
        },
      }),
    ]);

    res.json({
      success: true,
      stats: {
        total,
        open,
        inProgress,
        resolved,
        urgentOpen,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Admin: Update ticket status, internal admin notes, or user resolution
 */
async function updateTicketStatus(req, res, next) {
  try {
    const { id } = req.params;
    const { status, adminNotes, resolution } = req.body;

    const existing = await prisma.supportTicket.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    if (!existing) {
      return next(new AppError("Support ticket not found", 404));
    }

    const dataToUpdate = {};

    if (status && VALID_STATUSES.includes(status)) {
      dataToUpdate.status = status;
      if (status === "RESOLVED" && existing.status !== "RESOLVED") {
        dataToUpdate.resolvedAt = new Date();
        dataToUpdate.resolvedByAdminId = req.user.userId;
      }
    }

    if (adminNotes !== undefined) {
      dataToUpdate.adminNotes = adminNotes ? String(adminNotes).trim() : null;
    }

    if (resolution !== undefined) {
      dataToUpdate.resolution = resolution ? String(resolution).trim() : null;
    }

    const updated = await prisma.supportTicket.update({
      where: { id },
      data: dataToUpdate,
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        resolvedByAdmin: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    // Broadcast updated stats to all connected admin screens in real-time
    broadcastSupportStats();

    // Log admin action for auditability
    try {
      await prisma.adminActionLog.create({
        data: {
          userId: req.user.userId,
          action: "UPDATE",
          collectionKey: "supportTickets",
          recordId: updated.id,
          beforeData: {
            status: existing.status,
            adminNotes: existing.adminNotes,
            resolution: existing.resolution,
          },
          afterData: {
            status: updated.status,
            adminNotes: updated.adminNotes,
            resolution: updated.resolution,
          },
          metadata: {
            ticketNo: updated.ticketNo,
          },
        },
      });
    } catch (auditErr) {
      logger.error("Failed to log admin action on support ticket", {
        ticketId: updated.id,
        error: auditErr,
      });
    }

    // Send email notification to user if resolution changed or ticket marked resolved
    const resolutionChanged =
      resolution &&
      resolution.trim() &&
      resolution.trim() !== (existing.resolution || "").trim();
    const statusChanged = status && status !== existing.status;

    if ((statusChanged || resolutionChanged) && updated.user?.email) {
      (async () => {
        try {
          await sendSupportTicketStatusUpdateToUser({
            ticket: updated,
            user: updated.user,
            updatedByAdminName: req.user.name || "Admin",
          });
        } catch (emailErr) {
          logger.error("Failed to send ticket status email to user", {
            ticketId: updated.id,
            error: emailErr,
          });
        }
      })();
    }

    res.json({
      success: true,
      ticket: updated,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Admin: Delete a support ticket
 */
async function deleteTicket(req, res, next) {
  try {
    const { id } = req.params;

    const existing = await prisma.supportTicket.findUnique({
      where: { id },
    });

    if (!existing) {
      return next(new AppError("Support ticket not found", 404));
    }

    await prisma.supportTicket.delete({
      where: { id },
    });

    // Broadcast updated stats to all connected admin screens in real-time
    broadcastSupportStats();

    try {
      await prisma.adminActionLog.create({
        data: {
          userId: req.user.userId,
          action: "DELETE",
          collectionKey: "supportTickets",
          recordId: id,
          beforeData: existing,
          afterData: null,
          metadata: {
            ticketNo: existing.ticketNo,
          },
        },
      });
    } catch (_err) {
      // ignore audit log failure on delete
    }

    res.json({
      success: true,
      message: "Ticket deleted successfully",
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  createTicket,
  getMyTickets,
  getTicketById,
  listAllTickets,
  getSupportStats,
  updateTicketStatus,
  deleteTicket,
  streamAdminSupportLive,
};
