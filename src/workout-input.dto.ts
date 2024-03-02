import { z } from 'zod';

const DoubleSchema = z
  .string()
  .trim()
  .regex(/^\d{1,6}(\.\d{1,2})?$/)
  .transform(Number);
const DatetimeSchema = z
  .string()
  .trim()
  .datetime()
  .transform((value) => new Date(value));

export const WorkoutInputDto = z.object({
  id: z.string().trim().min(1).max(255),
  startTime: DatetimeSchema,
  endTime: DatetimeSchema,
  duration: DoubleSchema,
  totalDistance: DoubleSchema.optional(),
  workoutActivityType: z.string().trim().min(1),
  totalEnergyBurned: DoubleSchema,
  username: z.string().trim().min(1).max(255),
});

export type WorkoutInputDto = z.infer<typeof WorkoutInputDto>;
