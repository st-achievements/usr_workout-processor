import { exception } from '@st-api/core';
import { HttpStatus } from '@nestjs/common';

export const PERIOD_NOT_FOUND = exception({
  errorCode: 'USR-WP-0001',
  status: HttpStatus.INTERNAL_SERVER_ERROR,
  message: 'Period not found',
});
