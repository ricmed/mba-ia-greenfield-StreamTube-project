import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { BEARER_PREFIX } from '../auth.constants';
import { JwtPayload } from '../auth.types';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user: unknown }>();
    const authHeader = request.headers?.authorization;

    if (isPublic) {
      // Public routes stay open, but a valid token is still resolved so
      // handlers can tell an anonymous visitor from the resource owner
      // (e.g. a draft video is only visible to its channel).
      await this.attachUserIfTokenIsValid(request, authHeader);
      return true;
    }

    if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException();
    }

    const token = authHeader.slice(BEARER_PREFIX.length);

    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
      request.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }

  /** Best-effort resolution: an absent or invalid token simply leaves no user. */
  private async attachUserIfTokenIsValid(
    request: { user: unknown },
    authHeader: string | undefined,
  ): Promise<void> {
    if (!authHeader?.startsWith(BEARER_PREFIX)) return;

    try {
      request.user = await this.jwtService.verifyAsync<JwtPayload>(
        authHeader.slice(BEARER_PREFIX.length),
      );
    } catch {
      // Anonymous access to a public route — not an error.
    }
  }
}
