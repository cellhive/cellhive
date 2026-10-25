import { Module } from '@nestjs/common';

import { FileModule } from '../file/file.module.js';
import { ShareModule } from '../share/share.module.js';
import { ShareLinkModule } from '../share-link/share-link.module.js';
import { ViewModule } from '../view/view.module.js';

import { FormCoverController, ShareFormCoverController } from './form-cover.controller.js';
import { FormCoverService } from './form-cover.service.js';
import { FormSpamGuard } from './form-spam-guard.js';
import { FormController } from './form.controller.js';
import { FormService } from './form.service.js';
import { ShareFormInputsService } from './share-form-inputs.service.js';
import { ShareFormController } from './share-form.controller.js';

/**
 * Form submissions (SPEC §8, §15A; CONTRACTS §17; BACKLOG T306): the member
 * route and the share link route, with the anti-spam guard; the inputs of
 * link and attachment questions of form links (T410); form cover images (T419).
 */
@Module({
  imports: [ShareLinkModule, ShareModule, FileModule, ViewModule],
  controllers: [FormController, ShareFormController, FormCoverController, ShareFormCoverController],
  providers: [FormService, FormSpamGuard, ShareFormInputsService, FormCoverService],
})
export class FormModule {}
