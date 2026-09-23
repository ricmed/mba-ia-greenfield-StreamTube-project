import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class ResendConfirmationDto {
  @ApiProperty({
    description:
      'Account awaiting confirmation. The response is the same whether or not it exists.',
    format: 'email',
    example: 'someone@example.com',
  })
  @IsEmail()
  email: string;
}
