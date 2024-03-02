export interface WorkoutEventDto {
  workoutId: number;
  externalId: string;
  startedAt: string;
  endedAt: string;
  duration: number;
  distance?: number;
  workoutTypeId: number;
  workoutTypeName: string;
  workoutName?: string;
  energyBurned: number;
  userId: number;
  periodId: number;
}
