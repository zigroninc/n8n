import { type Response } from 'express';
import {
	type NodeTypeAndVersion,
	type IWebhookFunctions,
	type IWebhookResponseData,
	type IN8nHttpResponse,
	type IDataObject,
	ApplicationError,
	type IBinaryData,
	BINARY_ENCODING,
} from 'n8n-workflow';
import { type Readable } from 'node:stream';

import { sanitizeHtml } from './utils';

const getBinaryDataFromNode = (context: IWebhookFunctions, nodeName: string): IDataObject => {
	return context.evaluateExpression(`{{ $('${nodeName}').first().binary }}`) as IDataObject;
};

const respondWithBinary = (context: IWebhookFunctions, res: Response) => {
	const inputDataFieldName = context.getNodeParameter('inputDataFieldName', '') as string;

	const parentNodes = context.getParentNodes(context.getNode().name);

	const binaryNode = parentNodes.find((node) =>
		getBinaryDataFromNode(context, node?.name)?.hasOwnProperty(inputDataFieldName),
	);

	if (!binaryNode) {
		throw new ApplicationError('No binary data found.');
	}

	const binaryData = getBinaryDataFromNode(context, binaryNode?.name)[
		inputDataFieldName
	] as IBinaryData;

	let responseBody: IN8nHttpResponse | Readable;
	if (binaryData.id) {
		responseBody = { binaryData };
	} else {
		responseBody = Buffer.from(binaryData.data, BINARY_ENCODING);
	}

	// res.setHeader('Content-Type', binaryData.mimeType);
	// res.send(responseBody);

	return { noWebhookResponse: true };
};

export const renderFormCompletion = async (
	context: IWebhookFunctions,
	res: Response,
	trigger: NodeTypeAndVersion,
): Promise<IWebhookResponseData> => {
	const completionTitle = context.getNodeParameter('completionTitle', '') as string;
	const completionMessage = context.getNodeParameter('completionMessage', '') as string;
	const redirectUrl = context.getNodeParameter('redirectUrl', '') as string;
	const options = context.getNodeParameter('options', {}) as { formTitle: string };
	const respondWith = context.getNodeParameter('respondWith', '') as string;
	const responseText = context.getNodeParameter('responseText', '') as string;

	if (respondWith === 'returnBinary') {
		return respondWithBinary(context, res);
	}

	if (redirectUrl) {
		res.send(
			`<html><head><meta http-equiv="refresh" content="0; url=${redirectUrl}"></head></html>`,
		);
		return { noWebhookResponse: true };
	}

	let title = options.formTitle;
	if (!title) {
		title = context.evaluateExpression(`{{ $('${trigger?.name}').params.formTitle }}`) as string;
	}
	const appendAttribution = context.evaluateExpression(
		`{{ $('${trigger?.name}').params.options?.appendAttribution === false ? false : true }}`,
	) as boolean;

	res.render('form-trigger-completion', {
		title: completionTitle,
		message: completionMessage,
		formTitle: title,
		appendAttribution,
		responseText: sanitizeHtml(responseText),
	});

	return { noWebhookResponse: true };
};
