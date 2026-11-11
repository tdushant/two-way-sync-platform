import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import type { SalesforceRequest } from '../http/salesforce-request';
import { Dispatcher } from '../webhook/dispatcher';
import { SimulatorService } from './simulator.service';

@Controller('simulator')
export class SimulatorController {
  constructor(
    private readonly simulator: SimulatorService,
    private readonly dispatcher: Dispatcher,
  ) {}

  @Put('config')
  replaceConfig(@Req() request: SalesforceRequest, @Body() body: unknown): Promise<unknown> {
    return this.simulator.replaceConfig(body, request.correlationId);
  }

  @Post('reset')
  @HttpCode(200)
  reset(): Promise<unknown> {
    return this.simulator.reset();
  }

  @Post('emit-event')
  @HttpCode(200)
  emit(@Req() request: SalesforceRequest, @Body() body: unknown): Promise<unknown> {
    return this.simulator.emit(body, request.correlationId);
  }

  @Post('replay-event/:eventId')
  @HttpCode(200)
  replay(@Req() request: SalesforceRequest, @Param('eventId') eventId: string): Promise<unknown> {
    return this.simulator.replay(eventId, request.correlationId);
  }

  @Post('reorder-deliveries')
  @HttpCode(200)
  reorder(@Req() request: SalesforceRequest, @Body() body: unknown): Promise<unknown> {
    return this.simulator.reorder(body, request.correlationId);
  }

  @Post('flush-deliveries')
  @HttpCode(200)
  flush(): Promise<unknown> {
    return this.dispatcher.flush();
  }

  @Get('deliveries')
  deliveries(): Promise<unknown> {
    return this.simulator.deliveries();
  }

  @Get('requests')
  requests(): Promise<unknown> {
    return this.simulator.requests();
  }
}
