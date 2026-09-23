import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @ApiProperty({
    description: 'Address the confirmation link is sent to',
    format: 'email',
    example: 'someone@example.com',
  })
  @IsEmail()
  email: string;

  @ApiProperty({
    description: 'Plain password; only its hash is stored',
    minLength: 8,
    maxLength: 128,
    example: 'correct horse battery staple',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;
}
