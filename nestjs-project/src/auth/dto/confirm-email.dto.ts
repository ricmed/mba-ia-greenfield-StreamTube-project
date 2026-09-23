import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class ConfirmEmailDto {
  @ApiProperty({
    description: 'Single-use token delivered in the confirmation e-mail',
  })
  @IsString()
  @IsNotEmpty()
  token: string;
}
