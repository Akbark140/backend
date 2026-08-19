const repo = require('./bills.repository');
const { AppError } = require('../../shared/AppError');
const { mapBill, mapBills } = require('./bills.mapper');

// ── Helpers ───────────────────────────────────────────────

function isOverdue(dueDate, status) {
  if (status === 'paid') return false;
  return new Date(dueDate) < new Date(new Date().toDateString());
}

function getNextDueDate(dueDate, recurrence) {
  const date = new Date(dueDate);

  switch (recurrence) {
    case 'daily':   date.setDate(date.getDate() + 1);       break;
    case 'weekly':  date.setDate(date.getDate() + 7);       break;
    case 'monthly': date.setMonth(date.getMonth() + 1);     break;
    case 'yearly':  date.setFullYear(date.getFullYear() + 1); break;
    default:        return null;
  }

  return date.toISOString().split('T')[0];
}

// ── Service Functions ─────────────────────────────────────

async function getAllBills(userId) {
  const rows = await repo.findAllByUser(userId);

  // Auto-flag overdue on the way out — no extra DB call needed
  const normalized = (rows ?? []).map(row => ({
    ...row,
    status: isOverdue(row.due_date, row.status) ? 'overdue' : row.status,
  }));

  return mapBills(normalized);
}

async function getBillById(billId, userId) {
  const row = await repo.findById(billId, userId);

  if (!row) {
    throw new AppError('Bill not found', 404);
  }

  return mapBill({
    ...row,
    status: isOverdue(row.due_date, row.status) ? 'overdue' : row.status,
  });
}

async function getOverdueBills(userId) {
  const rows = await repo.findOverdue(userId);
  return mapBills((rows ?? []).map(row => ({ ...row, status: 'overdue' })));
}

async function getUpcomingBills(userId) {
  const rows = await repo.findUpcoming(userId);
  return mapBills(rows ?? []);
}

async function createBill(userId, data) {
  data.currency = data.currency || 'USD';
  data.recurrence = data.recurrence || 'none';
  data.status = data.status || 'unpaid';
  data.is_autopay = data.is_autopay ?? false;
  const row = await repo.createBill(userId, data);
  return mapBill(row);
}

async function updateBill(billId, userId, data) {
  // Confirm bill exists and belongs to user
  const existing = await repo.findById(billId, userId);
  if (!existing) {
    throw new AppError('Bill not found', 404);
  }

  const updated = await repo.updateBill(billId, userId, data);
  return mapBill(updated);
}

async function markAsPaid(billId, userId) {
  const existing = await repo.findById(billId, userId);
  if (!existing) {
    throw new AppError('Bill not found', 404);
  }

  if (existing.status === 'paid') {
    throw new AppError('Bill is already marked as paid', 400);
  }

  const updated = await repo.markAsPaid(billId, userId);

  // If recurring, auto-create next bill
  if (existing.recurrence && existing.recurrence !== 'none') {
    const nextDueDate = getNextDueDate(existing.dueDate, existing.recurrence);

    if (nextDueDate) {
      await repo.createBill(userId, {
        name: existing.name,
        amount: existing.amount,
        currency: existing.currency,
        due_date: nextDueDate,
        recurrence: existing.recurrence,
        category_id: existing.categoryId,
        status: 'unpaid',
        notes: existing.notes,
        is_autopay: existing.isAutopay,
      });
    }
  }

  return mapBill(updated);
}

async function markAsUnpaid(billId, userId) {
  const existing = await repo.findById(billId, userId);
  if (!existing) {
    throw new AppError('Bill not found', 404);
  }

  if (existing.status !== 'paid') {
    throw new AppError('Bill is not marked as paid', 400);
  }

  const updated = await repo.markAsUnpaid(billId, userId);
  return mapBill(updated);
}

async function deleteBill(billId, userId) {
  const existing = await repo.findById(billId, userId);
  if (!existing) {
    throw new AppError('Bill not found', 404);
  }

  await repo.deleteBill(billId, userId);
  return { id: billId, deleted: true };
}

module.exports = {
  getAllBills,
  getBillById,
  getOverdueBills,
  getUpcomingBills,
  createBill,
  updateBill,
  markAsPaid,
  markAsUnpaid,
  deleteBill,
};