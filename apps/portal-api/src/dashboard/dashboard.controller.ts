import { Controller, Get, Header } from '@nestjs/common';
import { DASHBOARD_HTML } from './dashboard-page';

@Controller()
export class DashboardController {
  @Get('dashboard')
  @Header('content-type', 'text/html; charset=utf-8')
  page(): string {
    return DASHBOARD_HTML;
  }
}
