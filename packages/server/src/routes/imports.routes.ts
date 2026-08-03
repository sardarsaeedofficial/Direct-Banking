import { Router } from "express";
import { z } from "zod";
import { csvMappingSchema } from "@direct-banking/shared";
import { prisma } from "../db.js";
import { requireCsrf } from "../auth/middleware.js";
import { validate, validated } from "../middleware/validate.js";
import { asyncHandler } from "../middleware/error.js";
import { audit } from "../services/audit.service.js";
import { previewCsv, commitCsv, rollbackBatch } from "../services/csv-import.service.js";

export const importsRouter = Router();

const previewBody = z.object({ text: z.string().min(1).max(5_000_000), mapping: csvMappingSchema });
const commitBody = previewBody.extend({ filename: z.string().max(200).optional(), skipDuplicates: z.boolean().default(true) });

importsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const items = await prisma.importBatch.findMany({
      where: { userId: req.auth!.userId },
      include: { _count: { select: { transactions: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json({ items });
  }),
);

importsRouter.post(
  "/preview",
  requireCsrf,
  validate(previewBody),
  asyncHandler(async (req, res) => {
    const { text, mapping } = validated<typeof previewBody>(res);
    const preview = await previewCsv(req.auth!.userId, text, mapping);
    // Only return the first 200 rows to the client for the preview table.
    res.json({ ...preview, rows: preview.rows.slice(0, 200) });
  }),
);

importsRouter.post(
  "/commit",
  requireCsrf,
  validate(commitBody),
  asyncHandler(async (req, res) => {
    const { text, mapping, filename, skipDuplicates } = validated<typeof commitBody>(res);
    const result = await commitCsv(req.auth!.userId, text, mapping, filename, skipDuplicates);
    await audit(req, "import.commit", { entityType: "ImportBatch", entityId: result.batchId, metadata: { imported: result.imported, skipped: result.skipped } });
    res.status(201).json(result);
  }),
);

importsRouter.post(
  "/:id/rollback",
  requireCsrf,
  asyncHandler(async (req, res) => {
    const deleted = await rollbackBatch(req.auth!.userId, req.params.id);
    await audit(req, "import.rollback", { entityType: "ImportBatch", entityId: req.params.id, metadata: { deleted } });
    res.json({ rolledBack: true, deleted });
  }),
);
