import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class ForgotPasswordDto {
  @ApiProperty({
    description:
      'Account to recover. The response is the same whether or not it exists.',
    format: 'email',
    example: 'someone@example.com',
  })
  @IsEmail()
  email: string;
}
