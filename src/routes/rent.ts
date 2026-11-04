import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { AuthenticatedRequest, getTenantScope, requireAuth, requireRole } from '../middleware/auth';
import { RentEngine } from '../services/rentEngine';
import { PaymentService } from '../services/paymentService';

const router = Router();

// Validation
const generateMonthlyRentSchema = z.object({
  billingYear: z.number().int().min(2020).max(2100),
  billingMonth: z.number().int().min(1).max(12),
  dryRun: z.boolean().optional().default(false),
  prorate: z.boolean().optional().default(true),
  propertyId: z.string().uuid().optional(),
});

const recordPaymentSchema = z.object({
  tenantId: z.string().uuid(),
  apartmentId: z.string().uuid(),
  amount: z.number().positive(),
  paymentMethodCode: z.enum(['CASH', 'BANK_TRANSFER', 'UPI', 'CARD', 'ONLINE', 'OTHER']).default('UPI'),
  transactionId: z.string().optional().nullable(),
  rentChargeId: z.string().uuid().optional().nullable(),
  notes: z.string().optional().nullable(),
});

const updateRentChargeSchema = z.object({
  dueDate: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Due date must use YYYY-MM-DD')
    .refine((value) => {
      const date = new Date(`${value}T00:00:00.000Z`);
      return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
    }, 'Due date is invalid')
    .optional(),
  rentAmount: z.number().positive().optional(),
  lateFee: z.number().nonnegative().optional(),
}).refine((data) => Object.keys(data).length > 0, 'At least one charge field must be updated');

// 1. GET rent status lookups
router.get('/meta/lookups', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const [statuses, methods] = await Promise.all([
      prisma.tsmib_rent_status.findMany(),
      prisma.tsmib_payment_method.findMany(),
    ]);
    res.json({ statuses, methods });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch lookups' });
  }
});

// 2. LIST rent charges with filters
router.get('/charges', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const tenantScope = getTenantScope(req, res);
    if (tenantScope === null) return;
    const { year, month, status, apartmentId } = req.query;

    const where: any = { organization_id: orgId };
    if (tenantScope) {
      where.tsmib_leases = {
        tsmib_lease_tenants: { some: { tenant_id: tenantScope } },
      };
    }
    if (year) where.billing_year = Number(year);
    if (month) where.billing_month = Number(month);
    if (apartmentId) where.apartment_id = String(apartmentId);
    if (status) {
      const statusRecord = await prisma.tsmib_rent_status.findFirst({
        where: { code: String(status) },
      });
      if (statusRecord) where.rent_status_id = statusRecord.id;
    }

    const charges = await prisma.tsmib_rent_charges.findMany({
      where,
      include: {
        tsmib_apartments: {
          include: {
            tsmib_buildings: {
              include: { tsmib_properties: { select: { id: true, name: true } } },
            },
          },
        },
        tsmib_rent_status: true,
        tsmib_leases: {
          include: {
            tsmib_lease_tenants: {
              where: { is_primary: true },
              include: { tsmib_tenants: true },
            },
          },
        },
        tsmib_payment_allocations: {
          include: {
            tsmib_payments: {
              include: {
                tsmib_payment_method: true,
                tsmib_payment_receipts: true,
              },
            },
          },
          orderBy: { created_at: 'desc' },
        },
      },
      orderBy: [{ billing_year: 'desc' }, { billing_month: 'desc' }, { due_date: 'asc' }],
    });

    const response = charges.map((c) => {
      const primaryTenant = c.tsmib_leases.tsmib_lease_tenants[0]?.tsmib_tenants;
      const totalPaid = c.tsmib_payment_allocations.reduce((sum, a) => sum + Number(a.amount), 0);
      const totalCharge = Number(c.rent_amount) + Number(c.late_fee || 0);

      return {
        id: c.id,
        leaseId: c.lease_id,
        apartmentId: c.apartment_id,
        tenantId: primaryTenant?.id ?? null,
        propertyId: c.tsmib_apartments.tsmib_buildings.tsmib_properties.id,
        propertyName: c.tsmib_apartments.tsmib_buildings.tsmib_properties.name,
        buildingId: c.tsmib_apartments.tsmib_buildings.id,
        apartmentNumber: c.tsmib_apartments.apartment_number,
        buildingName: c.tsmib_apartments.tsmib_buildings.name,
        tenantName: primaryTenant ? `${primaryTenant.first_name} ${primaryTenant.last_name || ''}`.trim() : 'Unknown',
        tenantPhone: primaryTenant?.phone,
        billingYear: c.billing_year,
        billingMonth: c.billing_month,
        dueDate: c.due_date,
        rentAmount: c.rent_amount,
        lateFee: c.late_fee,
        totalAmount: totalCharge,
        paidAmount: totalPaid,
        pendingAmount: Math.max(0, totalCharge - totalPaid),
        status: c.tsmib_rent_status.code,
        statusName: c.tsmib_rent_status.name,
        payments: c.tsmib_payment_allocations.map((allocation) => ({
          id: allocation.tsmib_payments.id,
          amount: Number(allocation.amount),
          paymentAmount: Number(allocation.tsmib_payments.amount),
          paymentReference: allocation.tsmib_payments.payment_reference,
          paymentDate: allocation.tsmib_payments.payment_date,
          method: allocation.tsmib_payments.tsmib_payment_method.name,
          transactionId: allocation.tsmib_payments.transaction_id,
          receiptNumber: allocation.tsmib_payments.tsmib_payment_receipts[0]?.receipt_number ?? null,
        })),
      };
    });

    res.json(response);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to list charges' });
  }
});

// Update a charge's amount and due date without changing its payment-derived status.
router.patch('/charges/:id', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const data = updateRentChargeSchema.parse(req.body);
    const charge = await prisma.tsmib_rent_charges.findFirst({
      where: { id: req.params.id, organization_id: orgId },
      include: { tsmib_payment_allocations: true, tsmib_rent_status: true },
    });
    if (!charge) return res.status(404).json({ error: 'Rent charge not found' });
    if (charge.tsmib_rent_status.code === 'CANCELLED' || charge.tsmib_rent_status.code === 'PAID') {
      return res.status(409).json({ error: 'Paid or cancelled rent charges cannot be edited.' });
    }

    const rentAmount = data.rentAmount ?? Number(charge.rent_amount);
    const lateFee = data.lateFee ?? Number(charge.late_fee || 0);
    const totalAmount = rentAmount + lateFee;
    const paidAmount = charge.tsmib_payment_allocations.reduce((sum, allocation) => sum + Number(allocation.amount), 0);
    if (totalAmount < paidAmount) {
      return res.status(400).json({ error: 'Charge total cannot be less than the amount already paid.' });
    }

    const updated = await prisma.tsmib_rent_charges.update({
      where: { id: charge.id },
      data: {
        ...(data.dueDate ? { due_date: new Date(`${data.dueDate}T00:00:00.000Z`) } : {}),
        rent_amount: rentAmount as any,
        late_fee: lateFee as any,
        updated_at: new Date(),
      },
    });
    const persisted = await prisma.tsmib_rent_charges.findFirst({
      where: { id: updated.id, organization_id: orgId },
      select: { id: true, due_date: true, rent_amount: true, late_fee: true, total_amount: true },
    });
    if (!persisted) return res.status(500).json({ error: 'Updated rent charge could not be read back.' });
    const persistedRentAmount = Number(persisted.rent_amount);
    const persistedLateFee = Number(persisted.late_fee || 0);
    const persistedTotal = persistedRentAmount + persistedLateFee;
    if (
      persistedRentAmount !== rentAmount
      || persistedLateFee !== lateFee
      || (data.dueDate && persisted.due_date.toISOString().slice(0, 10) !== data.dueDate)
    ) {
      return res.status(500).json({ error: 'Updated rent charge values did not persist as requested.' });
    }
    res.json({
      message: 'Rent charge updated successfully',
      charge: {
        id: persisted.id,
        dueDate: persisted.due_date,
        rentAmount: persistedRentAmount,
        lateFee: persistedLateFee,
        totalAmount: persistedTotal,
        paidAmount,
        pendingAmount: Math.max(0, persistedTotal - paidAmount),
        status: charge.tsmib_rent_status.code,
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    res.status(500).json({ error: error.message || 'Failed to update rent charge' });
  }
});

// 3. GENERATE MONTHLY RENT CHARGES (Phase 8: Idempotent Rent Engine)
router.post('/generate-charges', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const { billingYear, billingMonth, dryRun, prorate, propertyId } = generateMonthlyRentSchema.parse(req.body);

    const result = await RentEngine.generateMonthlyRentCharges({
      organizationId: orgId,
      billingYear,
      billingMonth,
      dryRun,
      prorate,
      propertyId,
    });

    res.json({
      message: dryRun
        ? `Rent preview generated for ${result.billingPeriod}`
        : `Rent generation completed for ${result.billingPeriod}`,
      ...result,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    res.status(500).json({ error: error.message || 'Failed to generate rent charges' });
  }
});

// 4. PROCESS OVERDUE CHARGES & APPLY LATE FEES (Phase 8: Late Fee & Status Engine)
router.post('/process-overdue', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const result = await RentEngine.processOverdueCharges(orgId);

    res.json({
      message: `Overdue processing completed: ${result.overdueChargesCount} charges marked OVERDUE (${result.lateFeesAppliedCount} late fees applied)`,
      ...result,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to process overdue charges' });
  }
});

// 5. GET RENT SUMMARY & COLLECTION RATE (Phase 8: Analytics Engine)
router.get('/summary', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const { year, month } = req.query;

    const summary = await RentEngine.getRentSummary(
      orgId,
      year ? Number(year) : undefined,
      month ? Number(month) : undefined
    );

    res.json(summary);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch rent summary' });
  }
});

// 6. RECORD PAYMENT (Phase 9 & 10: Payments, Allocations & Receipts)
router.post('/payments', requireAuth, requireRole(['OWNER', 'MANAGER', 'ADMIN']), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const orgId = req.user!.organizationId;
    const data = recordPaymentSchema.parse(req.body);

    const result = await PaymentService.recordPayment({
      organizationId: orgId,
      ...data,
    });

    res.status(201).json({
      message: 'Payment recorded and receipt generated successfully',
      ...result,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    res.status(500).json({ error: error.message || 'Failed to record payment' });
  }
});

export default router;
