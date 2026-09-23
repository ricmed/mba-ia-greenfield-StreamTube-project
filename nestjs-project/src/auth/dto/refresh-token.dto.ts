import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({
    description: 'Refresh token from the last token pair issued',
  })
  @IsString()
  @IsNotEmpty()
  refresh_token: string;
}
