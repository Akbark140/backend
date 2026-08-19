const service = require('./bills.service');

// GET /api/bills
async function getAllBills(req, res, next) {
  try {
    const bills = await service.getAllBills(req.user.id);

    res.status(200).json({
      success: true,
      data: bills,
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/bills/:id
async function getBillById(req, res, next) {
  try {
    const bill = await service.getBillById(
      req.params.id,
      req.user.id
    );

    res.status(200).json({
      success: true,
      data: bill,
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/bills/filter/overdue
async function getOverdueBills(req, res, next) {
  try {
    const bills = await service.getOverdueBills(req.user.id);

    res.status(200).json({
      success: true,
      data: bills,
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/bills/filter/upcoming
async function getUpcomingBills(req, res, next) {
  try {
    const bills = await service.getUpcomingBills(req.user.id);

    res.status(200).json({
      success: true,
      data: bills,
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/bills
async function createBill(req, res, next) {
  try {
    const bill = await service.createBill(
      req.user.id,
      req.validatedBody
    );

    console.log('CONTROLLER CREATE BILL:', bill);

    res.status(201).json({
      success: true,
      message: 'Bill created successfully',
      data: bill,
    });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/bills/:id
async function updateBill(req, res, next) {
  try {
    console.log('Body being passed:', req.validatedBody || req.body);
    const bill = await service.updateBill(
      req.params.id,
      req.user.id,
      req.validatedBody
    );

    res.status(200).json({
      success: true,
      message: 'Bill updated successfully',
      data: bill,
    });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/bills/:id/pay
async function markAsPaid(req, res, next) {
  try {
    const bill = await service.markAsPaid(
      req.params.id,
      req.user.id
    );

    res.status(200).json({
      success: true,
      message: 'Bill marked as paid',
      data: bill,
    });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/bills/:id/unpay
async function markAsUnpaid(req, res, next) {
  try {
    const bill = await service.markAsUnpaid(
      req.params.id,
      req.user.id
    );

    res.status(200).json({
      success: true,
      message: 'Bill marked as unpaid',
      data: bill,
    });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/bills/:id
async function deleteBill(req, res, next) {
  try {
    const result = await service.deleteBill(
      req.params.id,
      req.user.id
    );

    res.status(200).json({
      success: true,
      message: 'Bill deleted successfully',
      data: result,
    });
  } catch (err) {
    next(err);
  }
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